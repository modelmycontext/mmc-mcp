import { Database } from 'bun:sqlite';
import path from 'path';
import { logger } from '@src/utils/logger.js';

export class SqliteDataSource {
  private db: Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'data.db');
    this.db = new Database(dbPath);
  }

  async read(collection: string): Promise<any[]> {
    try {
      // Ensure table exists
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${collection} (id TEXT PRIMARY KEY, data TEXT)`);

      const rows = this.db.prepare(`SELECT data FROM ${collection}`).all() as any[];
      return rows.map(row => JSON.parse(row.data));
    } catch (error: any) {
      logger.error({ collection, error: error.message }, `[SqliteDataSource] Error reading ${collection}: ${error.message}`);
      return [];
    }
  }

  async write(collection: string, data: any[]): Promise<void> {
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${collection} (id TEXT PRIMARY KEY, data TEXT)`);

      const deleteStmt = this.db.prepare(`DELETE FROM ${collection}`);
      const insertStmt = this.db.prepare(`INSERT INTO ${collection} (id, data) VALUES (?, ?)`);

      this.db.exec('BEGIN TRANSACTION');
      try {
        deleteStmt.run();
        for (const item of data) {
          const id = item.id || item.ID || item.MemberID || item.memberId || Math.random().toString(36).substring(7);
          insertStmt.run(String(id), JSON.stringify(item));
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } catch (error: any) {
      logger.error({ collection, error: error.message }, `[SqliteDataSource] Error writing ${collection}: ${error.message}`);
    }
  }
}
