import Database from 'better-sqlite3';
import path from 'path';

export interface ChannelState {
  oldest_message_id: string | null;
  newest_message_id: string | null;
  last_downloaded_at: string;
  completed: boolean;
  guild_name: string | null;
  channel_name: string | null;
  parent_channel_name: string | null;
}

export type FileType = 'media' | 'emoji';

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

export interface MonitorAuthorRow {
  username: string;
  user_id: string | null;
  last_tweet_id: string | null;
  last_tweet_ts: number | null;
  active: number;
  added_at: string;
  include_posts: number;
  include_replies: number;
  include_reposts: number;
  media_only: number;
  hashtag_filter: number;
}

export interface MonitorAuthorConfig {
  include_posts?: number;
  include_replies?: number;
  include_reposts?: number;
  media_only?: number;
  hashtag_filter?: number;
}

export interface MonitorSeenTweetRow {
  tweet_id: string;
  username: string;
  created_timestamp: number | null;
  processed_at: string;
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
        type TEXT NOT NULL CHECK(type IN ('media', 'emoji')),
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

    // Migration: add name columns for folder rename tracking
    const columns = this.db.prepare("PRAGMA table_info(channel_state)").all() as { name: string }[];
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has('guild_name')) this.db.exec('ALTER TABLE channel_state ADD COLUMN guild_name TEXT');
    if (!colNames.has('channel_name')) this.db.exec('ALTER TABLE channel_state ADD COLUMN channel_name TEXT');
    if (!colNames.has('parent_channel_name')) this.db.exec('ALTER TABLE channel_state ADD COLUMN parent_channel_name TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_authors (
        guild_id TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL,
        user_id TEXT,
        last_tweet_id TEXT,
        last_tweet_ts INTEGER,
        active INTEGER DEFAULT 1,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, username)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_seen_tweets (
        guild_id TEXT NOT NULL DEFAULT '',
        tweet_id TEXT NOT NULL,
        username TEXT NOT NULL,
        created_timestamp INTEGER,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, tweet_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_config (
        guild_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (guild_id, key)
      )
    `);

    this.migrateMonitorTables();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_monitor_seen_guild_username_ts
        ON monitor_seen_tweets(guild_id, username, created_timestamp)
    `);
  }

  private migrateMonitorTables(): void {
    const hasTable = (name: string): boolean =>
      !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    const columns = (name: string): string[] =>
      (this.db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);

    if (hasTable('monitor_authors') && !columns('monitor_authors').includes('guild_id')) {
      this.db.exec('ALTER TABLE monitor_authors RENAME TO monitor_authors_old');
      this.db.exec(`
        CREATE TABLE monitor_authors (
          guild_id TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL,
          user_id TEXT,
          last_tweet_id TEXT,
          last_tweet_ts INTEGER,
          active INTEGER DEFAULT 1,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (guild_id, username)
        )
      `);
      this.db.exec(`
        INSERT INTO monitor_authors (guild_id, username, user_id, last_tweet_id, last_tweet_ts, active, added_at)
        SELECT '', username, NULL, last_tweet_id, last_tweet_ts, active, added_at FROM monitor_authors_old
      `);
      this.db.exec('DROP TABLE monitor_authors_old');
    } else if (hasTable('monitor_authors') && !columns('monitor_authors').includes('user_id')) {
      this.db.exec('ALTER TABLE monitor_authors ADD COLUMN user_id TEXT');
    }

    if (hasTable('monitor_authors') && !columns('monitor_authors').includes('include_posts')) {
      this.db.exec(`
        ALTER TABLE monitor_authors ADD COLUMN include_posts INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE monitor_authors ADD COLUMN include_replies INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monitor_authors ADD COLUMN include_reposts INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE monitor_authors ADD COLUMN media_only INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE monitor_authors ADD COLUMN hashtag_filter INTEGER NOT NULL DEFAULT 0;
      `);
    }

    if (hasTable('monitor_seen_tweets') && !columns('monitor_seen_tweets').includes('guild_id')) {
      this.db.exec('ALTER TABLE monitor_seen_tweets RENAME TO monitor_seen_tweets_old');
      this.db.exec(`
        CREATE TABLE monitor_seen_tweets (
          guild_id TEXT NOT NULL DEFAULT '',
          tweet_id TEXT NOT NULL,
          username TEXT NOT NULL,
          created_timestamp INTEGER,
          processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (guild_id, tweet_id)
        )
      `);
      this.db.exec(`
        INSERT INTO monitor_seen_tweets (guild_id, tweet_id, username, created_timestamp, processed_at)
        SELECT '', tweet_id, username, created_timestamp, processed_at FROM monitor_seen_tweets_old
      `);
      this.db.exec('DROP TABLE monitor_seen_tweets_old');
    }

    if (hasTable('monitor_config') && !columns('monitor_config').includes('guild_id')) {
      this.db.exec('ALTER TABLE monitor_config RENAME TO monitor_config_old');
      this.db.exec(`
        CREATE TABLE monitor_config (
          guild_id TEXT NOT NULL DEFAULT '',
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (guild_id, key)
        )
      `);
      this.db.exec(`
        INSERT INTO monitor_config (guild_id, key, value)
        SELECT '', key, value FROM monitor_config_old
      `);
      this.db.exec('DROP TABLE monitor_config_old');
    }
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
      guild_name: string | null;
      channel_name: string | null;
      parent_channel_name: string | null;
    }
    const row = this.db.prepare(
      'SELECT oldest_message_id, newest_message_id, last_downloaded_at, completed, guild_name, channel_name, parent_channel_name FROM channel_state WHERE guild_id = ? AND channel_id = ?'
    ).get(guildId, channelId) as Row | undefined;
    if (!row) return null;
    return {
      oldest_message_id: row.oldest_message_id,
      newest_message_id: row.newest_message_id,
      last_downloaded_at: row.last_downloaded_at,
      completed: row.completed === 1,
      guild_name: row.guild_name,
      channel_name: row.channel_name,
      parent_channel_name: row.parent_channel_name,
    };
  }

  updateChannelState(
    guildId: string,
    channelId: string,
    oldestMessageId: string,
    newestMessageId: string,
    guildName?: string,
    channelName?: string,
    parentChannelName?: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO channel_state (guild_id, channel_id, oldest_message_id, newest_message_id, completed, last_downloaded_at, guild_name, channel_name, parent_channel_name)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        oldest_message_id = ?,
        newest_message_id = ?,
        completed = 1,
        last_downloaded_at = CURRENT_TIMESTAMP,
        guild_name = COALESCE(?, guild_name),
        channel_name = COALESCE(?, channel_name),
        parent_channel_name = COALESCE(?, parent_channel_name)
    `).run(
      guildId, channelId, oldestMessageId, newestMessageId,
      guildName ?? null, channelName ?? null, parentChannelName ?? null,
      oldestMessageId, newestMessageId,
      guildName ?? null, channelName ?? null, parentChannelName ?? null,
    );
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

  markChannelIncomplete(
    guildId: string,
    channelId: string,
    guildName?: string,
    channelName?: string,
    parentChannelName?: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO channel_state (guild_id, channel_id, completed, guild_name, channel_name, parent_channel_name)
      VALUES (?, ?, 0, ?, ?, ?)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        completed = 0,
        guild_name = COALESCE(?, guild_name),
        channel_name = COALESCE(?, channel_name),
        parent_channel_name = COALESCE(?, parent_channel_name)
    `).run(
      guildId, channelId,
      guildName ?? null, channelName ?? null, parentChannelName ?? null,
      guildName ?? null, channelName ?? null, parentChannelName ?? null,
    );
  }

  listMonitorGuilds(): string[] {
    return (this.db.prepare('SELECT DISTINCT guild_id FROM monitor_authors').all() as { guild_id: string }[])
      .map((r) => r.guild_id);
  }

  listMonitorAuthors(guildId: string): MonitorAuthorRow[] {
    return this.db.prepare(
      'SELECT username, user_id, last_tweet_id, last_tweet_ts, active, added_at, include_posts, include_replies, include_reposts, media_only, hashtag_filter FROM monitor_authors WHERE guild_id = ? AND active = 1 ORDER BY added_at'
    ).all(guildId) as MonitorAuthorRow[];
  }

  getMonitorAuthor(guildId: string, username: string): MonitorAuthorRow | null {
    const row = this.db.prepare(
      'SELECT username, user_id, last_tweet_id, last_tweet_ts, active, added_at, include_posts, include_replies, include_reposts, media_only, hashtag_filter FROM monitor_authors WHERE guild_id = ? AND username = ?'
    ).get(guildId, username) as MonitorAuthorRow | undefined;
    return row || null;
  }

  findMonitorAuthorCI(guildId: string, username: string): MonitorAuthorRow | null {
    const row = this.db.prepare(
      'SELECT username, user_id, last_tweet_id, last_tweet_ts, active, added_at, include_posts, include_replies, include_reposts, media_only, hashtag_filter FROM monitor_authors WHERE guild_id = ? AND lower(username) = lower(?)'
    ).get(guildId, username) as MonitorAuthorRow | undefined;
    return row || null;
  }

  findMonitorAuthorByUserId(guildId: string, userId: string): MonitorAuthorRow | null {
    const row = this.db.prepare(
      'SELECT username, user_id, last_tweet_id, last_tweet_ts, active, added_at, include_posts, include_replies, include_reposts, media_only, hashtag_filter FROM monitor_authors WHERE guild_id = ? AND user_id = ?'
    ).get(guildId, userId) as MonitorAuthorRow | undefined;
    return row || null;
  }

  addMonitorAuthor(guildId: string, username: string, userId: string | null = null): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO monitor_authors (guild_id, username, user_id, active) VALUES (?, ?, ?, 1)'
    ).run(guildId, username, userId);
  }

  removeMonitorAuthor(guildId: string, username: string): void {
    this.db.prepare('DELETE FROM monitor_authors WHERE guild_id = ? AND username = ?').run(guildId, username);
    this.db.prepare('DELETE FROM monitor_seen_tweets WHERE guild_id = ? AND username = ?').run(guildId, username);
  }

  removeAllMonitorAuthors(guildId: string): number {
    const result = this.db.prepare('DELETE FROM monitor_authors WHERE guild_id = ?').run(guildId);
    this.db.prepare('DELETE FROM monitor_seen_tweets WHERE guild_id = ?').run(guildId);
    return result.changes;
  }

  updateMonitorAuthorCursor(guildId: string, username: string, lastTweetId: string, lastTweetTs: number): void {
    this.db.prepare(`
      UPDATE monitor_authors SET last_tweet_id = ?, last_tweet_ts = ? WHERE guild_id = ? AND username = ?
    `).run(lastTweetId, lastTweetTs, guildId, username);
  }

  updateMonitorAuthorUserId(guildId: string, username: string, userId: string): void {
    this.db.prepare('UPDATE monitor_authors SET user_id = ? WHERE guild_id = ? AND username = ?').run(userId, guildId, username);
  }

  updateMonitorAuthorConfig(guildId: string, username: string, cfg: MonitorAuthorConfig): void {
    const { include_posts, include_replies, include_reposts, media_only, hashtag_filter } = cfg;
    this.db.prepare(`
      UPDATE monitor_authors SET
        include_posts = COALESCE(?, include_posts),
        include_replies = COALESCE(?, include_replies),
        include_reposts = COALESCE(?, include_reposts),
        media_only = COALESCE(?, media_only),
        hashtag_filter = COALESCE(?, hashtag_filter)
      WHERE guild_id = ? AND username = ?
    `).run(
      include_posts ?? null,
      include_replies ?? null,
      include_reposts ?? null,
      media_only ?? null,
      hashtag_filter ?? null,
      guildId,
      username,
    );
  }

  renameMonitorAuthor(guildId: string, oldUsername: string, newUsername: string): boolean {
    try {
      const result = this.db.prepare('UPDATE monitor_authors SET username = ? WHERE guild_id = ? AND username = ?')
        .run(newUsername, guildId, oldUsername);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  getMonitorConfig(guildId: string, key: string, fallback?: string): string | null {
    const row = this.db.prepare('SELECT value FROM monitor_config WHERE guild_id = ? AND key = ?').get(guildId, key) as { value: string } | undefined;
    return row ? row.value : (fallback ?? null);
  }

  setMonitorConfig(guildId: string, key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO monitor_config (guild_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value
    `).run(guildId, key, value);
  }

  close(): void {
    this.db.close();
  }
}
