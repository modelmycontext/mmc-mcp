import fs from 'fs/promises';
import path from 'path';
import { logger } from '@src/utils/logger.js';

export class JsonDataSource {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async read(collection: string): Promise<any[]> {
    const filePath = path.join(this.dataDir, `${collection}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Collection "${collection}" not found. Available collections are in the data directory.`);
      }
      logger.error({ collection, error: String(error) }, `[JsonDataSource] Error reading ${collection}: ${error}`);
      return [];
    }
  }

  async write(collection: string, data: any[]): Promise<void> {
    const filePath = path.join(this.dataDir, `${collection}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }
}
