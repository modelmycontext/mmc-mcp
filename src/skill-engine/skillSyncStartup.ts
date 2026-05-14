import path from 'path';
import fs from 'fs';
import { SkillSync } from './skillSync.js';
import { ExternalMcpManager } from '@src/server/externalMcpManager.js';
import { logger } from '@src/utils/logger.js';

export interface AppConfig {
  skillsDir: string;
  noSync: boolean;
  forceSync: boolean;
}

/**
 * Reads skillsDir and noSync flag from config/config.json and CLI arguments.
 */
export function readAppConfig(): AppConfig {
  let appConfig: AppConfig = { skillsDir: 'skills', noSync: false, forceSync: false };
  const configPath = path.join(process.cwd(), 'config', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      appConfig = { ...appConfig, ...configData };
    } catch (err: any) {
      logger.error({ error: err.message }, `[SkillSyncStartup] Error reading config.json: ${err.message}`);
    }
  }

  if (process.env.MMC_SKIP_SYNC) {
    appConfig.noSync = true;
    logger.info(`[SkillSyncStartup] GitHub skill synchronization disabled via MMC_SKIP_SYNC env.`);
  }

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-sync') {
      appConfig.noSync = true;
      logger.info(`[SkillSyncStartup] GitHub skill synchronization disabled via --no-sync.`);
    } else if (args[i] === '--force-sync') {
      appConfig.forceSync = true;
      logger.info(`[SkillSyncStartup] Force-sync enabled — SHA cache will be cleared before syncing.`);
    } else if ((args[i] === '--skill-dir' || args[i] === '--skills') && i + 1 < args.length) {
      appConfig.skillsDir = args[++i];
      logger.info({ skillsDir: appConfig.skillsDir }, `[SkillSyncStartup] Skills directory set to: ${appConfig.skillsDir}`);
    } else if (args[i].startsWith('--skill-dir=') || args[i].startsWith('--skills=')) {
      appConfig.skillsDir = args[i].split('=')[1];
      logger.info({ skillsDir: appConfig.skillsDir }, `[SkillSyncStartup] Skills directory set to: ${appConfig.skillsDir}`);
    }
  }

  return appConfig;
}

/**
 * Syncs skills from GitHub on startup using config/github_skills.json.
 * Returns the list of synced file names.
 */
export async function syncSkillsOnStartup(
  skillsDir: string,
  externalMcpManager: ExternalMcpManager,
  noSync = false,
  forceSync = false
): Promise<string[]> {
  if (noSync) {
    logger.info('[SkillSyncStartup] GitHub sync disabled.');
    return [];
  }

  const projectRoot = process.cwd();
  const resolvedSkillsDir = path.isAbsolute(skillsDir)
    ? skillsDir
    : path.join(projectRoot, skillsDir);

  if (forceSync) {
    const stateFile = path.join(resolvedSkillsDir, '.sync-state.json');
    try {
      await fs.promises.unlink(stateFile);
      logger.info('[SkillSyncStartup] SHA cache cleared for force-sync.');
    } catch {
      // File may not exist yet — fine
    }
  }

  const syncer = new SkillSync(resolvedSkillsDir, externalMcpManager);
  try {
    const synced = await syncer.syncFromGithub();
    return synced;
  } catch (err: any) {
    logger.error({ error: err.message }, `[SkillSyncStartup] Error syncing from GitHub: ${err.message}`);
    return [];
  }
}
