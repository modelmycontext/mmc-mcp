import fs from 'fs/promises';
import path from 'path';
import { ExternalMcpManager } from '@src/server/externalMcpManager.js';
import { logger } from '@src/utils/logger.js';

const SYNC_STATE_FILE = '.sync-state.json';
// Safety net: if cached SHA state is older than this, ignore it and do a full resync.
const SHA_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

interface ShaStateFile {
  syncedAt: number;
  shas: Record<string, string>;
}

export class SkillSync {
  private skillsDir: string;
  private externalMcpManager?: ExternalMcpManager;
  // sha map: github file path → last-synced sha
  private shaState: Record<string, string> = {};
  // Tracks all remote file paths seen during current sync (for deletion detection)
  private remotePathsSeen = new Set<string>();
  // Per-sync counters for end-of-run summary.
  private counters = { downloaded: 0, skipped: 0, deleted: 0, fetchErrors: 0, writeErrors: 0 };

  constructor(skillsDir: string, externalMcpManager?: ExternalMcpManager) {
    this.skillsDir = skillsDir;
    this.externalMcpManager = externalMcpManager;
  }

  private get stateFilePath(): string {
    return path.join(this.skillsDir, SYNC_STATE_FILE);
  }

  private async loadShaState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Back-compat: older state files were a flat sha map with no syncedAt.
      if (parsed && typeof parsed === 'object' && 'shas' in parsed && 'syncedAt' in parsed) {
        const state = parsed as ShaStateFile;
        const age = Date.now() - state.syncedAt;
        if (age > SHA_STATE_MAX_AGE_MS) {
          logger.info({ ageMs: age, maxAgeMs: SHA_STATE_MAX_AGE_MS }, '[SkillSync] SHA state expired — forcing full resync');
          this.shaState = {};
          return;
        }
        this.shaState = state.shas ?? {};
      } else {
        // Legacy flat map — treat as expired so we resync once, then the new format will take over.
        logger.info('[SkillSync] Legacy SHA state format — forcing full resync once');
        this.shaState = {};
      }
    } catch {
      this.shaState = {};
    }
  }

  private async saveShaState(): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
    const state: ShaStateFile = { syncedAt: Date.now(), shas: this.shaState };
    await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
  }

  public decodeGithubContent(content: string): string {
    if (!content) return content;

    // 1. Try to parse as JSON first (standard for many GitHub API tools)
    try {
      // The GitHub MCP server might return a JSON string in the text field
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        if (parsed.content) {
          if (parsed.encoding === 'base64') {
             // GitHub API content is often base64, but sometimes it's already decoded by the MCP server
             // If it starts with common markdown, it's already decoded.
             if (parsed.content.trim().startsWith('#') || parsed.content.includes('\n')) {
                 return parsed.content;
             }
             const cleanBase64 = parsed.content.replace(/\r?\n|\r/g, '');
             return Buffer.from(cleanBase64, 'base64').toString('utf8');
          }
          return parsed.content;
        }
      }
    } catch (e) {
      // Not JSON
    }

    return content;
  }

  async syncFromGithub(): Promise<string[]> {
    const t0 = Date.now();
    const syncedFiles: string[] = [];
    if (!this.externalMcpManager) {
      logger.warn('[SkillSync] No ExternalMcpManager — skipping GitHub sync');
      return syncedFiles;
    }

    const githubClient = this.externalMcpManager.getClient('github');
    if (!githubClient) {
      logger.warn('[SkillSync] GitHub MCP client not available — skipping sync');
      return syncedFiles;
    }

    const configPath = path.join(process.cwd(), 'config', 'config.json');
    let config;
    try {
      const configText = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(configText);
      config = parsed.mmcGithubServer;
    } catch (e: any) {
      logger.error({ configPath, error: e.message }, '[SkillSync] Could not read config.json — skipping sync');
      return syncedFiles;
    }

    if (!Array.isArray(config)) {
      logger.warn('[SkillSync] config.mmcGithubServer is missing or not an array — skipping sync');
      return syncedFiles;
    }

    // Interpolate {{VAR}} tokens in each entry's string fields from process.env.
    // Mirrors the pattern used for externalServers env in externalMcpManager.ts.
    const resolveEnv = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      const m = value.match(/^\{\{(.+)\}\}$/);
      if (!m) return value;
      return process.env[m[1]] ?? '';
    };
    config = config
      .map((entry: any) => {
        const resolved: any = {};
        for (const [k, v] of Object.entries(entry)) resolved[k] = resolveEnv(v);
        return resolved;
      })
      .filter((entry: any) => {
        if (!entry.owner || !entry.repo) {
          logger.warn(
            { entry },
            '[SkillSync] Skipping repo — owner/repo unresolved (set MMC_GITHUB_OWNER and MMC_GITHUB_REPO in .env)'
          );
          return false;
        }
        return true;
      });

    if (config.length === 0) {
      logger.warn('[SkillSync] No repos configured after env interpolation — skipping sync');
      return syncedFiles;
    }

    await this.loadShaState();
    this.remotePathsSeen.clear();
    this.counters = { downloaded: 0, skipped: 0, deleted: 0, fetchErrors: 0, writeErrors: 0 };

    logger.info(
      { repoCount: config.length, cachedShas: Object.keys(this.shaState).length },
      '[SkillSync] Starting GitHub sync'
    );

    for (const repoInfo of config) {
      const { owner, repo, path: repoPath, branch } = repoInfo;
      if (!owner || !repo) {
        logger.warn({ repoInfo }, '[SkillSync] Skipping repo entry — missing owner or repo');
        continue;
      }

      logger.info({ owner, repo, branch: branch ?? '(default)', path: repoPath || '(root)' }, '[SkillSync] Syncing repo');
      try {
        const repoSynced = await this.syncDirectoryRecursively(githubClient, owner, repo, repoPath || '', branch);
        syncedFiles.push(...repoSynced);
      } catch (err: any) {
        logger.error({ owner, repo, branch, error: err.message }, '[SkillSync] Repo sync failed');
      }
    }

    // Remove SHA entries for files no longer present in the remote repo
    const removedPaths: string[] = [];
    for (const cachedPath of Object.keys(this.shaState)) {
      if (!this.remotePathsSeen.has(cachedPath)) {
        removedPaths.push(cachedPath);
        delete this.shaState[cachedPath];
      }
    }
    if (removedPaths.length > 0) {
      logger.info({ count: removedPaths.length, paths: removedPaths }, '[SkillSync] Deleting local files that no longer exist in remote');
      for (const remotePath of removedPaths) {
        await this.deleteLocalFile(remotePath);
        this.counters.deleted++;
      }
    }

    await this.saveShaState();
    logger.info(
      {
        totalMs: Date.now() - t0,
        ...this.counters,
        remotePathsSeen: this.remotePathsSeen.size,
      },
      '[SkillSync] GitHub sync complete'
    );
    return syncedFiles;
  }

  /**
   * Deletes a local skill/model file that no longer exists in the remote repo.
   * Also removes empty parent directories up to the skills root.
   */
  private async deleteLocalFile(remotePath: string): Promise<void> {
    // Determine the local path based on file type
    let localPath: string | null = null;

    if (remotePath.endsWith('.md')) {
      const pathParts = remotePath.split('/');
      const fileName = pathParts[pathParts.length - 1];
      const sliceName = fileName.replace('.md', '');
      const skillsIdx = pathParts.indexOf('skills');
      if (skillsIdx > 0) {
        const activityName = pathParts[skillsIdx - 1];
        localPath = path.join(this.skillsDir, activityName, sliceName, fileName);
      }
    } else if (remotePath.endsWith('.json')) {
      const pathParts = remotePath.split('/');
      const fileName = pathParts[pathParts.length - 1];
      const activityName = fileName.replace('.json', '');
      localPath = path.join(this.skillsDir, activityName, fileName);
    }

    if (!localPath) return;

    try {
      await fs.unlink(localPath);
      logger.debug({ remotePath, localPath }, '[SkillSync] Deleted local file');
      // Try to remove empty parent directories
      let dir = path.dirname(localPath);
      while (dir !== this.skillsDir && dir.startsWith(this.skillsDir)) {
        const entries = await fs.readdir(dir);
        if (entries.length === 0) {
          await fs.rmdir(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      }
    } catch (e: any) {
      // ENOENT is expected — file already gone
      if (e.code !== 'ENOENT') {
        logger.warn({ remotePath, localPath, error: e.message }, '[SkillSync] Failed to delete local file');
      }
    }
  }

  private async saveSkillFile(filePath: string, content: string): Promise<string | null> {
    if (!filePath.endsWith('.md')) return null;

    const actualContent = this.decodeGithubContent(content);
    const pathParts = filePath.split('/');
    const fileName = pathParts.pop() || '';
    const sliceName = fileName.replace('.md', '');

    // The user wants each slice in its own folder with the same name (excluding .md)
    // inside the activity folder.
    // Find index of "skills" folder
    const skillsIdx = pathParts.indexOf('skills');
    let activityName = '';
    let targetDir = this.skillsDir;

    if (skillsIdx > 0) {
      activityName = pathParts[skillsIdx - 1];
      targetDir = path.join(this.skillsDir, activityName, sliceName);
    } else {
      // Fallback if "skills" is not in path
      activityName = pathParts[pathParts.length - 1] || '';
      targetDir = activityName ? path.join(this.skillsDir, activityName, sliceName) : path.join(this.skillsDir, sliceName);
    }

    await fs.mkdir(targetDir, { recursive: true });

    // "internally the skill names are incorrectly formatted. They should be activity name - slice.md name"
    // This refers to the 'name:' field in the frontmatter.
    let updatedContent = actualContent;
    const nameMatch = actualContent.match(/^name:\s*(.*)/m);
    const newSkillName = activityName ? `${activityName} - ${sliceName}` : sliceName;

    if (!nameMatch) {
      if (actualContent.startsWith('---')) {
        // If name field is missing but frontmatter exists, insert it
        updatedContent = actualContent.replace(/^---\r?\n/, `---\nname: ${newSkillName}\n`);
      }
    }

    const finalPath = path.join(targetDir, fileName);
    await fs.writeFile(finalPath, updatedContent);

    return activityName ? `${activityName}/${sliceName}/${fileName}` : `${sliceName}/${fileName}`;
  }

  private async saveModelFile(filePath: string, content: string): Promise<string | null> {
    const actualContent = this.decodeGithubContent(content);
    const pathParts = filePath.split('/');
    const fileName = pathParts[pathParts.length - 1]; // '<activity-name>.json'
    const activityName = fileName.replace('.json', '');

    if (!activityName) return null;

    const targetDir = path.join(this.skillsDir, activityName);
    await fs.mkdir(targetDir, { recursive: true });

    const finalPath = path.join(targetDir, fileName);
    await fs.writeFile(finalPath, actualContent);

    return `${activityName}/${fileName}`;
  }

  private async syncDirectoryRecursively(githubClient: any, owner: string, repo: string, currentPath: string, branch?: string): Promise<string[]> {
    const syncedFiles: string[] = [];
    let items: any[] | undefined;

    try {
      const response = await githubClient.callTool({
        name: 'get_file_contents',
        arguments: {
          owner,
          repo,
          path: currentPath,
          branch: branch
        }
      });

      const textContent = (response.content as any[])?.find(c => (c as any).type === 'text')?.text;
      if (textContent) {
        try {
          // If it's a directory, it returns a JSON array of items
          const parsed = JSON.parse(textContent);
          if (Array.isArray(parsed)) {
            items = parsed;
          } else {
            // It's a single file content
            const savedPath = await this.saveSkillFile(currentPath, textContent);
            if (savedPath) {
              this.counters.downloaded++;
              syncedFiles.push(savedPath);
            }
            return syncedFiles;
          }
        } catch (e) {
          // Not JSON, probably a file content
          const savedPath = await this.saveSkillFile(currentPath, textContent);
          if (savedPath) {
            this.counters.downloaded++;
            syncedFiles.push(savedPath);
          }
          return syncedFiles;
        }
      }
    } catch (e: any) {
      this.counters.fetchErrors++;
      logger.warn({ owner, repo, path: currentPath, branch, error: e.message }, '[SkillSync] Fetch failed for path');
    }

    // Process directory items — files and subdirs run in parallel.
    if (items && Array.isArray(items)) {
      const hasSkillsSubdir = items.some(i => i.type === 'dir' && i.name === 'skills');

      const results = await Promise.all(items.map(async (item): Promise<string[]> => {
        if (item.type === 'file' && item.name.endsWith('.md')) {
          this.remotePathsSeen.add(item.path);
          // Skip if SHA unchanged since last sync.
          if (item.sha && this.shaState[item.path] === item.sha) {
            this.counters.skipped++;
            logger.debug({ path: item.path, sha: item.sha }, '[SkillSync] Skipped unchanged skill');
            return [];
          }
          try {
            const fileResponse = await githubClient.callTool({
              name: 'get_file_contents',
              arguments: { owner, repo, path: item.path, branch: branch }
            });
            const textContent = (fileResponse.content as any[])?.find(c => (c as any).type === 'text')?.text;
            if (textContent) {
              const savedPath = await this.saveSkillFile(item.path, textContent);
              if (savedPath) {
                if (item.sha) this.shaState[item.path] = item.sha;
                this.counters.downloaded++;
                logger.info({ path: item.path, sha: item.sha, localPath: savedPath }, '[SkillSync] Downloaded skill');
                return [savedPath];
              } else {
                this.counters.writeErrors++;
                logger.warn({ path: item.path }, '[SkillSync] saveSkillFile returned null — content not written');
              }
            }
          } catch (e: any) {
            this.counters.fetchErrors++;
            logger.warn({ path: item.path, error: e.message }, '[SkillSync] Skill download failed');
          }
        } else if (item.type === 'file' && item.name.endsWith('.json') && hasSkillsSubdir) {
          this.remotePathsSeen.add(item.path);
          if (item.sha && this.shaState[item.path] === item.sha) {
            this.counters.skipped++;
            logger.debug({ path: item.path, sha: item.sha }, '[SkillSync] Skipped unchanged model');
            return [];
          }
          try {
            const fileResponse = await githubClient.callTool({
              name: 'get_file_contents',
              arguments: { owner, repo, path: item.path, branch: branch }
            });
            const textContent = (fileResponse.content as any[])?.find(c => (c as any).type === 'text')?.text;
            if (textContent) {
              const savedPath = await this.saveModelFile(item.path, textContent);
              if (savedPath) {
                if (item.sha) this.shaState[item.path] = item.sha;
                this.counters.downloaded++;
                logger.info({ path: item.path, sha: item.sha, localPath: savedPath }, '[SkillSync] Downloaded model');
                return [savedPath];
              } else {
                this.counters.writeErrors++;
                logger.warn({ path: item.path }, '[SkillSync] saveModelFile returned null — content not written');
              }
            }
          } catch (e: any) {
            this.counters.fetchErrors++;
            logger.warn({ path: item.path, error: e.message }, '[SkillSync] Model download failed');
          }
        } else if (item.type === 'dir') {
          return this.syncDirectoryRecursively(githubClient, owner, repo, item.path, branch);
        }
        return [];
      }));

      syncedFiles.push(...results.flat());
    }

    return syncedFiles;
  }
}
