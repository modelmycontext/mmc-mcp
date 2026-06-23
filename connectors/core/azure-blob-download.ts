import type { Connector } from '@sdk/connectorTypes.js';
import { BlobServiceClient } from '@azure/storage-blob';
import { ParquetReader } from '@dsnp/parquetjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DOWNLOAD_DIR = 'data/downloads';

function rowsToCSV(rows: Record<string, any>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: any): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'bigint' ? v.toString() : String(v);
    return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map(row => headers.map(h => escape(row[h])).join(','))
  ].join('\n');
}

const bigintReplacer = (_key: string, value: any) =>
  typeof value === 'bigint' ? value.toString() : value;

export const azureBlobDownloadConnector: Connector = {
  name: 'azure-blob-download',
  description:
    'Downloads a Snappy-compressed Parquet blob from Azure Blob Storage and saves a converted CSV or JSON copy locally. ',

  inputParams: [
    {
      name: 'containerName',
      type: 'string',
      required: true,
      description: 'Azure Blob Storage container name, e.g. mcpdemo123'
    },
    {
      name: 'blobPath',
      type: 'string',
      required: true,
      description: 'Full blob path within the container, e.g. taxi/2018-01-part-00000.snappy.parquet'
    },
    {
      name: 'outputFormat',
      type: 'string',
      required: false,
      description: 'Converted output format: csv or json (default: csv)'
    },
    {
      name: 'referenceKey',
      type: 'string',
      required: false,
      description: 'Grouping key for the stored file. Defaults to containerName.'
    }
  ],

  outputParams: [
    { name: 'documentRef', type: 'string', description: 'UUID reference for the stored converted file' },
    { name: 'storagePath', type: 'string', description: 'Relative local path to the converted file' },
    { name: 'rowCount', type: 'number', description: 'Number of data rows in the converted file' },
    { name: 'sizeBytes', type: 'number', description: 'Byte size of the converted output file' }
  ],

  parse: (_section: string) => ({}),

  getAssignedVariables: () => ({
    assignedVariables: ['documentRef', 'storagePath', 'rowCount', 'sizeBytes']
  }),

  execute: async (ctx: any, params: Record<string, any>, input: any) => {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = params.containerName || input.containerName;
    const blobPath = params.blobPath || input.blobPath;
    const outputFormat = (params.outputFormat || input.outputFormat || 'csv').toLowerCase();
    const referenceKey = params.referenceKey || input.referenceKey || containerName;

    if (!connStr) {
      throw new Error(
        'connectionString param or AZURE_STORAGE_CONNECTION_STRING env var is required'
      );
    }
    if (!containerName) throw new Error('containerName is required');
    if (!blobPath) throw new Error('blobPath is required');
    if (outputFormat !== 'csv' && outputFormat !== 'json') {
      throw new Error('outputFormat must be csv or json');
    }

    // Download blob to buffer
    const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlockBlobClient(blobPath);
    // Existence pre-check gives a clear error when the XML body is empty (e.g. wrong account name)
    const containerExists = await containerClient.exists().catch(() => false);
    if (!containerExists) {
      throw new Error(
        `Container "${containerName}" not found. ` +
        `Verify the storage account name in your connection string and that the container exists.`
      );
    }
    const blobExists = await blobClient.exists().catch(() => false);
    if (!blobExists) {
      throw new Error(
        `Blob not found: "${blobPath}" in container "${containerName}". ` +
        `Verify the blob path is correct (paths are case-sensitive).`
      );
    }

    let rawBuffer: Buffer;
    try {
      rawBuffer = await blobClient.downloadToBuffer();
    } catch (err: any) {
      const status = err.statusCode ?? err.status ?? 'unknown';
      const code = err.code ?? err.errorCode ?? '';
      const msg = err.message ?? String(err);
      const details = err.details ? ` | details: ${JSON.stringify(err.details)}` : '';
      throw new Error(`Azure download failed [HTTP ${status}] ${code}: ${msg}${details}`);
    }

    // Parse Parquet (handles Snappy decompression internally)
    const reader = await ParquetReader.openBuffer(rawBuffer);
    const cursor = reader.getCursor();
    const rows: Record<string, any>[] = [];
    let record: unknown;
    while ((record = await cursor.next()) !== null) {
      rows.push(record as Record<string, any>);
    }
    await reader.close();

    // Convert to target format
    let content: string;
    let ext: string;
    if (outputFormat === 'json') {
      content = JSON.stringify(rows, bigintReplacer, 2);
      ext = '.json';
    } else {
      content = rowsToCSV(rows);
      ext = '.csv';
    }
    const outputBuffer = Buffer.from(content, 'utf-8');

    // Store locally using the same sidecar pattern as file-store
    const safeKey = String(referenceKey).replace(/[^a-zA-Z0-9_-]/g, '_');
    const docId = crypto.randomUUID();
    const storedName = `${docId}${ext}`;
    const dir = path.resolve(DOWNLOAD_DIR, safeKey);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, storedName);
    await fs.writeFile(filePath, outputBuffer);

    const meta = {
      documentRef: docId,
      referenceKey,
      containerName,
      blobPath,
      originalName: path.basename(blobPath),
      storedName,
      outputFormat,
      rowCount: rows.length,
      sizeBytes: outputBuffer.length,
      downloadedAt: new Date().toISOString()
    };
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify(meta, null, 2));

    return {
      documentRef: docId,
      storagePath: path.relative('.', filePath),
      rowCount: rows.length,
      sizeBytes: outputBuffer.length
    };
  }
};
