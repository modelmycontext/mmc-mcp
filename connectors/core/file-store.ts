import type { Connector } from '@sdk/connectorTypes.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const UPLOAD_DIR = 'data/files';

export const fileStoreConnector: Connector = {
  name: 'file-store',
  description:
    "Stores or relocates a file under a reference key. Two modes: " +
    "(1) Store — pass `fileName` + `contentBase64` + `referenceKey` to write a new file and receive a `documentRef`. " +
    "(2) Move — pass `documentRef` + `referenceKey` (no `contentBase64`) to relocate a previously-stored file to a new reference key.",
  inputParams: [
    { name: "referenceKey", type: "string", required: true, description: "A grouping key for the stored file. Must be the actual identifier value for the record being attached to, not a field/fact name." },
    { name: "fileName", type: "string", required: false, description: "Original file name including extension. Required in store mode; ignored in move mode." },
    { name: "contentBase64", type: "string", required: false, description: "Base64-encoded file content. Required in store mode; omit to invoke move mode." },
    { name: "mimeType", type: "string", required: false, description: "MIME type of the file (default: application/octet-stream)" },
    { name: "documentRef", type: "string", required: false, description: "Existing document reference (or array of references) returned by prior store call(s). Required in move mode. Passing an array moves all referenced files to the new referenceKey in a single call." }
  ],
  outputParams: [
    { name: "documentRef", type: "string", description: "Unique reference for the stored file" },
    { name: "storagePath", type: "string", description: "Relative path where the file was saved" }
  ],
  parse: (_section: string) => ({}),
  getAssignedVariables: () => ({ assignedVariables: ['documentRef', 'storagePath'] }),

  execute: async (_ctx: any, params: Record<string, any>, input: any) => {
    const referenceKey = params.referenceKey || input.referenceKey;
    const fileName = params.fileName || input.fileName;
    const contentBase64 = params.contentBase64 || input.contentBase64;
    const mimeType = params.mimeType || input.mimeType || 'application/octet-stream';
    const documentRef = params.documentRef || input.documentRef;

    // ── Move mode: relocate one or more previously-stored files to a new referenceKey ──
    if (!contentBase64 && documentRef) {
      if (!referenceKey) {
        throw new Error('referenceKey is required in move mode');
      }
      const safeKey = String(referenceKey).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filesRoot = path.resolve(UPLOAD_DIR);
      const targetDir = path.join(filesRoot, safeKey);
      await fs.mkdir(targetDir, { recursive: true });

      // Accept a single ref, an array of refs, or a JSON-stringified array
      // (LLMs serialise arrays to text when facts are declared as text type).
      // Preserve the input shape in the response so single-ref callers still
      // see the old object shape.
      let normalisedRef: any = documentRef;
      let inputWasArray = Array.isArray(documentRef);
      if (!inputWasArray && typeof documentRef === 'string') {
        const trimmed = documentRef.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              normalisedRef = parsed;
              inputWasArray = true;
            }
          } catch { /* not valid JSON — treat as literal string */ }
        }
      }
      const refs: string[] = (inputWasArray ? normalisedRef : [normalisedRef])
        .map((r: any) => String(r).trim())
        .filter(Boolean);

      // Snapshot directory listing once; reuse across all refs.
      const dirs = await fs.readdir(filesRoot);
      const dirListings = new Map<string, string[]>();
      for (const d of dirs) {
        const dPath = path.join(filesRoot, d);
        try {
          const stat = await fs.stat(dPath);
          if (!stat.isDirectory()) continue;
          dirListings.set(d, await fs.readdir(dPath));
        } catch { /* skip */ }
      }

      const results: { documentRef: string; storagePath: string }[] = [];
      for (const ref of refs) {
        let sourceDirName: string | null = null;
        let sourceEntries: string[] = [];
        for (const [d, entries] of dirListings) {
          const matches = entries.filter(e => e.startsWith(ref));
          if (matches.length) {
            sourceDirName = d;
            sourceEntries = matches;
            break;
          }
        }
        if (!sourceDirName) {
          throw new Error(`No file found for documentRef "${ref}"`);
        }

        const sourceDir = path.join(filesRoot, sourceDirName);
        if (sourceDir !== targetDir) {
          for (const entry of sourceEntries) {
            await fs.rename(path.join(sourceDir, entry), path.join(targetDir, entry));
          }
          // Update the cached listing so subsequent refs see the moved file
          // in the target directory, not the source.
          const srcList = dirListings.get(sourceDirName) ?? [];
          dirListings.set(sourceDirName, srcList.filter(e => !sourceEntries.includes(e)));
          const tgtList = dirListings.get(safeKey) ?? [];
          dirListings.set(safeKey, [...tgtList, ...sourceEntries]);

          // Remove source directory if it's now empty.
          try {
            const remaining = await fs.readdir(sourceDir);
            if (remaining.length === 0) await fs.rmdir(sourceDir);
          } catch { /* non-fatal */ }
        }

        // Update the sidecar's referenceKey so file-list reports the new key.
        const metaName = sourceEntries.find(e => e.endsWith('.meta.json'));
        if (metaName) {
          const metaPath = path.join(targetDir, metaName);
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const meta = JSON.parse(raw);
            meta.referenceKey = referenceKey;
            await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
          } catch { /* skip malformed sidecar */ }
        }

        const storedName = sourceEntries.find(e => !e.endsWith('.meta.json'));
        const storagePath = storedName
          ? path.relative('.', path.join(targetDir, storedName))
          : path.relative('.', targetDir);
        results.push({ documentRef: ref, storagePath });
      }

      if (inputWasArray) {
        return {
          documentRef: results.map(r => r.documentRef),
          storagePath: results.map(r => r.storagePath),
          documents: results,
        };
      }
      return results[0];
    }

    // ── Store mode: create a new file from base64 content ──
    if (!referenceKey || !fileName || !contentBase64) {
      throw new Error('referenceKey, fileName, and contentBase64 are all required in store mode');
    }

    // Sanitise to prevent path traversal
    const safeName = path.basename(fileName);
    const safeKey = referenceKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const docId = crypto.randomUUID();
    const ext = path.extname(safeName);
    const storedName = `${docId}${ext}`;

    const dir = path.resolve(UPLOAD_DIR, safeKey);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, storedName);
    const buffer = Buffer.from(contentBase64, 'base64');
    await fs.writeFile(filePath, buffer);

    // Write a sidecar metadata JSON so file-list can read it back
    const meta = {
      documentRef: docId,
      referenceKey,
      originalName: safeName,
      storedName,
      mimeType,
      sizeBytes: buffer.length,
      storedAt: new Date().toISOString()
    };
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify(meta, null, 2));

    return { documentRef: docId, storagePath: path.relative('.', filePath) };
  }
};
