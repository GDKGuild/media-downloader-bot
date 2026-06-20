import Database from 'better-sqlite3';
import path from 'path';

export interface ChannelState {
  oldest_message_id: string | null;
  newest_message_id: string | null;
  last_downloaded_at: string;
  completed: boolean;
}

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.DB_PATH || path.join(process.cwd(), 'media_hashes.db');
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_hashes (
        hash TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        guild_id TEXT,
        channel_id TEXT,
        message_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_state (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        oldest_message_id TEXT,
        newest_message_id TEXT,
        last_downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, channel_id)
      )
    `);

    // migration for existing DBs that lack newest_message_id
    try { this.db.exec(`ALTER TABLE channel_state ADD COLUMN newest_message_id TEXT`); } catch {}
    // migration: track whether the last download session completed
    try { this.db.exec(`ALTER TABLE channel_state ADD COLUMN completed INTEGER DEFAULT 1`); } catch {}
  }

  hasHash(hash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM media_hashes WHERE hash = ?').get(hash);
  }

  insertHash(hash: string, filename: string, fileSize: number, guildId: string | null, channelId: string | null, messageId: string | null): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO media_hashes (hash, filename, file_size, guild_id, channel_id, message_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(hash, filename, fileSize, guildId, channelId, messageId);
  }

  getChannelState(guildId: string, channelId: string): ChannelState | null {
    interface Row {
      oldest_message_id: string | null;
      newest_message_id: string | null;
      last_downloaded_at: string;
      completed: number;
    }
    const row = this.db.prepare(
      'SELECT oldest_message_id, newest_message_id, last_downloaded_at, completed FROM channel_state WHERE guild_id = ? AND channel_id = ?'
    ).get(guildId, channelId) as Row | undefined;
    if (!row) return null;
    return {
      oldest_message_id: row.oldest_message_id,
      newest_message_id: row.newest_message_id,
      last_downloaded_at: row.last_downloaded_at,
      completed: row.completed === 1,
    };
  }

  updateChannelState(guildId: string, channelId: string, oldestMessageId: string, newestMessageId: string): void {
    this.db.prepare(`
      INSERT INTO channel_state (guild_id, channel_id, oldest_message_id, newest_message_id, completed, last_downloaded_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        oldest_message_id = ?,
        newest_message_id = ?,
        completed = 1,
        last_downloaded_at = CURRENT_TIMESTAMP
    `).run(guildId, channelId, oldestMessageId, newestMessageId, oldestMessageId, newestMessageId);
  }

  updateOldestMessageId(guildId: string, channelId: string, oldestMessageId: string): void {
    this.db.prepare(`
      INSERT INTO channel_state (guild_id, channel_id, oldest_message_id, completed, last_downloaded_at)
      VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        oldest_message_id = ?,
        completed = 1,
        last_downloaded_at = CURRENT_TIMESTAMP
    `).run(guildId, channelId, oldestMessageId, oldestMessageId);
  }

  markChannelIncomplete(guildId: string, channelId: string): void {
    this.db.prepare(`
      INSERT INTO channel_state (guild_id, channel_id, completed)
      VALUES (?, ?, 0)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET completed = 0
    `).run(guildId, channelId);
  }

  close(): void {
    this.db.close();
  }
}
