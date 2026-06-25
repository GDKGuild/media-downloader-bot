import Database from 'better-sqlite3';
import path from 'path';

export interface ChannelState {
  oldest_message_id: string | null;
  newest_message_id: string | null;
  last_downloaded_at: string;
  completed: boolean;
}

export type FileType = 'media' | 'avatar' | 'emoji';

export interface FileHashRow {
  hash: string;
  guild_id: string;
  channel_id: string;
  type: FileType;
  url: string | null;
  filename: string;
  file_size: number;
  category: string | null;
  created_at: string;
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
      CREATE TABLE IF NOT EXISTS file_hashes (
        hash TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('media', 'avatar', 'emoji')),
        url TEXT,
        filename TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        category TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (hash, guild_id, channel_id, type)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_hashes_url
        ON file_hashes(url, guild_id, channel_id, type)
        WHERE url IS NOT NULL
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_state (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        oldest_message_id TEXT,
        newest_message_id TEXT,
        last_downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed INTEGER DEFAULT 1,
        PRIMARY KEY (guild_id, channel_id)
      )
    `);
  }

  hasFileHash(hash: string, guildId: string, channelId: string, type: FileType): boolean {
    return !!this.db.prepare(
      'SELECT 1 FROM file_hashes WHERE hash = ? AND guild_id = ? AND channel_id = ? AND type = ?'
    ).get(hash, guildId, channelId, type);
  }

  hasFileUrl(url: string, guildId: string, channelId: string, type: FileType): boolean {
    return !!this.db.prepare(
      'SELECT 1 FROM file_hashes WHERE url = ? AND guild_id = ? AND channel_id = ? AND type = ?'
    ).get(url, guildId, channelId, type);
  }

  getFileHash(hash: string, guildId: string, channelId: string, type: FileType): FileHashRow | null {
    const row = this.db.prepare(
      'SELECT hash, guild_id, channel_id, type, url, filename, file_size, category, created_at FROM file_hashes WHERE hash = ? AND guild_id = ? AND channel_id = ? AND type = ?'
    ).get(hash, guildId, channelId, type) as FileHashRow | undefined;
    return row || null;
  }

  insertFileHash(
    hash: string,
    guildId: string,
    channelId: string,
    type: FileType,
    url: string | null,
    filename: string,
    fileSize: number,
    category: string | null,
  ): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO file_hashes (hash, guild_id, channel_id, type, url, filename, file_size, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(hash, guildId, channelId, type, url, filename, fileSize, category);
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
