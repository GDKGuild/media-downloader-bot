import { Client, TextChannel, Message, ChatInputCommandInteraction } from 'discord.js';
import axios from 'axios';
import { readFileSync } from 'fs';
import * as path from 'path';
import { DatabaseService, MonitorAuthorRow } from './databaseService';

const API_BASE = 'https://api.fxtwitter.com/2/profile';
const API_STATUS = 'https://api.fxtwitter.com/2/status';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_FIXERS: string[] = ['fixupx.com', 'fixvx.com', 'fxtwitter.com', 'vxtwitter.com', 'cunnyx.com'];

export interface MonitorTweetMedia {
  url: string;
  type: string;
}

export interface MonitorTweet {
  type?: string;
  id: string | number;
  url: string;
  text?: string;
  raw_text?: { text?: string; facets?: { type?: string; original?: string }[] };
  created_timestamp?: number;
  media?: { all?: MonitorTweetMedia[] };
  author?: { id?: string; screen_name?: string };
  quote?: MonitorTweet;
  replying_to?: { screen_name?: string; status?: string | number; url?: string } | null;
  reposted_by?: { id?: string; screen_name?: string } | null;
}

export interface MonitorVerifyAllEntry {
  username: string;
  status: 'posted' | 'skipped' | 'identity-mismatch' | 'no-posts' | 'failed' | 'no-channel';
  tweetId: string | null;
}

export interface MonitorVerifyAllResult {
  channelId: string | null;
  entries: MonitorVerifyAllEntry[];
}

export interface MonitorVerifyResult {
  found: boolean;
  tweetId: string | null;
  channelId: string | null;
  posted: boolean;
  reason?: 'identity-mismatch';
}

const TWEET_URL_RE = /\bhttps?:\/\/(?:www\.)?(?:x|twitter|fixupx|fixvx|fxtwitter|vxtwitter|cunnyx)\.com\/[^\s]*?\/status\/(\d+)/i;

export function extractTweetId(text: string): string | null {
  const match = TWEET_URL_RE.exec(text);
  return match ? match[1] : null;
}

export interface ProfileInfo {
  screen_name: string;
  id: string;
}

export function normalizeUsername(raw: string): string | null {
  const cleaned = raw.trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(cleaned)) return null;
  return cleaned;
}

export function hasMedia(tweet: MonitorTweet): boolean {
  const all = tweet.media?.all;
  return !!all && all.length > 0;
}

export async function fetchParent(tweet: MonitorTweet): Promise<MonitorTweet | null> {
  const parentId = tweet.replying_to?.status;
  if (!parentId) return null;
  try {
    const res = await axios.get(`${API_STATUS}/${encodeURIComponent(String(parentId))}`, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      validateStatus: (s) => s === 200 || s === 404,
    });
    if (res.status !== 200) return null;
    const data = res.data as { status?: MonitorTweet } | undefined;
    return data?.status ?? null;
  } catch {
    return null;
  }
}

export async function replyParentHasMedia(tweet: MonitorTweet): Promise<boolean> {
  const parent = await fetchParent(tweet);
  return !!parent && hasMedia(parent);
}

export async function isIncludeable(tweet: MonitorTweet): Promise<boolean> {
  if (hasMedia(tweet)) return true;
  if (tweet.replying_to?.status) return await replyParentHasMedia(tweet);
  return false;
}

export type MonitorTweetKind = 'post' | 'reply' | 'repost';

export function tweetKind(tweet: MonitorTweet): MonitorTweetKind {
  if (tweet.reposted_by) return 'repost';
  if (tweet.replying_to) return 'reply';
  return 'post';
}

function tweetText(tweet: MonitorTweet): string {
  return tweet.raw_text?.text ?? tweet.text ?? '';
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{M}\p{N}_]+/gu);
  if (!matches) return [];
  return matches.map((m) => m.slice(1).toLowerCase());
}

function hasConfiguredHashtag(tweet: MonitorTweet, hashtags: string[]): boolean {
  const tweetTags = extractHashtags(tweetText(tweet));
  return hashtags.some((t) => tweetTags.includes(t));
}

export function parseHashtagFile(content: string): string[] {
  const tags: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '#' || line.startsWith('# ')) continue;
    tags.push(line.replace(/^#/, '').toLowerCase());
  }
  return tags;
}

function getMonitorPageSize(): number {
  const n = parseInt(process.env.MONITOR_PAGE_SIZE || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 200 ? n : 100;
}

function getMaxCatchup(): number {
  const n = parseInt(process.env.MONITOR_MAX_CATCHUP || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 500 ? n : 25;
}

function getHashtagFile(): string {
  const file = process.env.MONITOR_HASHTAG_FILE || 'monitor-hashtags.txt';
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

export function tweetIdentity(tweet: MonitorTweet): { id: string | null; screen_name: string | null } {
  return {
    id: tweet.reposted_by?.id ?? tweet.author?.id ?? null,
    screen_name: tweet.reposted_by?.screen_name ?? tweet.author?.screen_name ?? null,
  };
}

function swapDomain(url: string, domain: string): string {
  return url.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com/i, `https://${domain}`);
}

export async function resolveProfile(username: string): Promise<ProfileInfo | null> {
  try {
    const res = await axios.get(`${API_BASE}/${encodeURIComponent(username)}`, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      validateStatus: (s) => s === 200 || s === 404,
    });
    if (res.status === 404) return null;
    const data = res.data as { user?: { screen_name?: string; id?: string } } | undefined;
    if (!data?.user?.screen_name) return null;
    return { screen_name: data.user.screen_name, id: data.user.id || '' };
  } catch {
    return null;
  }
}

export async function verifyHandle(username: string): Promise<string | null> {
  const profile = await resolveProfile(username);
  return profile?.screen_name ?? null;
}

export async function resolveTweetAuthor(tweetId: string): Promise<{ screen_name: string; userId: string } | null> {
  try {
    const res = await axios.get(`${API_STATUS}/${encodeURIComponent(tweetId)}`, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      validateStatus: (s) => s === 200 || s === 404,
    });
    if (res.status !== 200) return null;
    const data = res.data as { status?: { author?: { screen_name?: string; id?: string } } } | undefined;
    const author = data?.status?.author;
    if (!author?.screen_name) return null;
    return { screen_name: author.screen_name, userId: author.id || '' };
  } catch {
    return null;
  }
}

export async function fetchLatestTweet(username: string): Promise<MonitorTweet | null> {
  try {
    const res = await axios.get(`${API_BASE}/${encodeURIComponent(username)}/statuses`, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      validateStatus: (s) => s === 200 || s === 204 || s === 404,
    });
    if (res.status !== 200) return null;
    const data = res.data as { code?: number; results?: unknown[] } | undefined;
    if (!data || data.code !== 200 || !Array.isArray(data.results)) return null;
    const tweets = data.results.filter((r): r is MonitorTweet => !!r && typeof r === 'object' && (r as MonitorTweet).type === 'status');
    for (const tweet of tweets) {
      if (await isIncludeable(tweet)) return tweet;
    }
    return null;
  } catch {
    return null;
  }
}

export class TweetMonitorService {
  private client: Client;
  private db: DatabaseService;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private pendingAwait = new Map<string, {
    expiresAt: number;
    channelId: string;
    requesterId: string;
    timer: NodeJS.Timeout;
    interaction?: ChatInputCommandInteraction;
  }>();

  constructor(client: Client, db: DatabaseService) {
    this.client = client;
    this.db = db;
  }

  armAwait(guildId: string, channelId: string, requesterId: string, minutes: number, interaction?: ChatInputCommandInteraction): void {
    this.cancelAwait(guildId);
    const ms = minutes * 60_000;
    const timer = setTimeout(() => {
      this.pendingAwait.delete(guildId);
      void this.client.channels.fetch(channelId).then((ch) => {
        if (ch && ch.isTextBased()) {
          const target = ch as TextChannel;
          void target.send('Monitor await timed out — no tweet link was posted. Run `/monitor await` to try again.');
        }
      }).catch(() => {});
    }, ms);
    this.pendingAwait.set(guildId, { expiresAt: Date.now() + ms, channelId, requesterId, timer, interaction });
  }

  cancelAwait(guildId: string): boolean {
    const pending = this.pendingAwait.get(guildId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingAwait.delete(guildId);
    return true;
  }

  isAwaitArmed(guildId: string): boolean {
    const pending = this.pendingAwait.get(guildId);
    return !!pending && pending.expiresAt > Date.now();
  }

  async handleAwaitMessage(message: Message): Promise<boolean> {
    if (message.author.bot) return false;
    const guildId = message.guild?.id;
    if (!guildId) return false;
    const pending = this.pendingAwait.get(guildId);
    if (!pending || pending.expiresAt <= Date.now()) return false;

    const tweetId = extractTweetId(message.content);
    if (!tweetId) return false;

    this.cancelAwait(guildId);
    try {
      const author = await resolveTweetAuthor(tweetId);
      if (!author) {
        await this.confirmAwait(pending, message, `Could not resolve tweet \`${tweetId}\` — the link may be invalid or the post was deleted. Run \`/monitor await\` to try again.`);
        return true;
      }
      const existingById = author.userId ? this.db.findMonitorAuthorByUserId(guildId, author.userId) : null;
      const existingByCI = this.db.findMonitorAuthorCI(guildId, author.screen_name);
      const existing = existingById ?? existingByCI;
      if (existing) {
        this.db.updateMonitorAuthorUserId(guildId, existing.username, author.userId);
        await this.confirmAwait(pending, message, `@${existing.username} is already being monitored in this server.`);
        return true;
      }
      this.db.addMonitorAuthor(guildId, author.screen_name, author.userId);
      await this.confirmAwait(pending, message, `Now monitoring **@${author.screen_name}** (user \`${author.userId}\`). The next poll baselines their timeline; new posts are relayed after that.`);
    } catch (err) {
      console.error(`[Monitor] Await resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.safeAwaitReply(message, 'Something went wrong resolving that tweet. Please try again.');
    }
    return true;
  }

  private async safeAwaitReply(message: Message, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch {
      // channel may be gone or bot lacks permission
    }
  }

  private async confirmAwait(
    pending: { interaction?: ChatInputCommandInteraction } | undefined,
    message: Message,
    content: string,
  ): Promise<void> {
    if (pending?.interaction) {
      try {
        await pending.interaction.editReply(content);
        return;
      } catch {
        // deferred reply token likely expired — fall back to a normal message reply
      }
    }
    await this.safeAwaitReply(message, content);
  }

  getChannelId(guildId: string): string | null {
    return this.db.getMonitorConfig(guildId, 'target_channel_id');
  }

  getIntervalMinutes(guildId: string): number {
    const raw = this.db.getMonitorConfig(guildId, 'poll_interval_minutes');
    const n = parseInt(raw || '', 10);
    return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : 15;
  }

  getEffectiveIntervalMinutes(): number {
    const guilds = this.db.listMonitorGuilds();
    if (guilds.length === 0) return 15;
    return Math.min(...guilds.map((g) => this.getIntervalMinutes(g)));
  }

  getFixers(guildId: string): string[] {
    const raw = this.db.getMonitorConfig(guildId, 'fixer_list');
    if (raw) {
      try {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr) && arr.length > 0) return arr.map(String);
      } catch {
        // fall through to defaults
      }
    }
    return [...DEFAULT_FIXERS];
  }

  setChannel(guildId: string, channelId: string): void {
    this.db.setMonitorConfig(guildId, 'target_channel_id', channelId);
  }

  setIntervalMinutes(guildId: string, minutes: number): void {
    this.db.setMonitorConfig(guildId, 'poll_interval_minutes', String(minutes));
    this.refresh();
  }

  setFixers(guildId: string, list: string[]): void {
    this.db.setMonitorConfig(guildId, 'fixer_list', JSON.stringify(list));
  }

  async verify(author: MonitorAuthorRow, guildId: string): Promise<MonitorVerifyResult> {
    const tweet = await fetchLatestTweet(author.username);
    if (!tweet) return { found: false, tweetId: null, channelId: null, posted: false };

    const tweetAuthorId = tweetIdentity(tweet).id;
    if (author.user_id && (!tweetAuthorId || author.user_id !== tweetAuthorId)) {
      return { found: false, tweetId: String(tweet.id), channelId: null, posted: false, reason: 'identity-mismatch' };
    }
    if (!author.user_id && tweetAuthorId) {
      this.db.updateMonitorAuthorUserId(guildId, author.username, tweetAuthorId);
    }

    const channelId = this.getChannelId(guildId);
    if (!channelId) return { found: true, tweetId: String(tweet.id), channelId: null, posted: false };
    try {
      await this.relayTweet(tweet, author.username, channelId, guildId);
      return { found: true, tweetId: String(tweet.id), channelId, posted: true };
    } catch (err) {
      console.error(`[Monitor] Verify relay @${author.username}/${tweet.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { found: true, tweetId: String(tweet.id), channelId, posted: false };
    }
  }

  async verifyAll(guildId: string): Promise<MonitorVerifyAllResult> {
    const channelId = this.getChannelId(guildId);
    const authors = this.db.listMonitorAuthors(guildId);
    const entries: MonitorVerifyAllEntry[] = [];

    for (const author of authors) {
      const entry: MonitorVerifyAllEntry = { username: author.username, status: 'no-posts', tweetId: null };
      try {
        const tweet = await fetchLatestTweet(author.username);
        if (tweet) {
          entry.tweetId = String(tweet.id);
          const tweetAuthorId = tweetIdentity(tweet).id;
          const identityOk = !author.user_id || (tweetAuthorId && author.user_id === tweetAuthorId);
          if (!identityOk) {
            entry.status = 'identity-mismatch';
          } else if (author.last_tweet_id === entry.tweetId) {
            entry.status = 'skipped';
          } else if (!channelId) {
            entry.status = 'no-channel';
          } else {
            if (!author.user_id && tweetAuthorId) {
              this.db.updateMonitorAuthorUserId(guildId, author.username, tweetAuthorId);
            }
            await this.relayTweet(tweet, author.username, channelId, guildId);
            this.db.updateMonitorAuthorCursor(guildId, author.username, entry.tweetId, tweet.created_timestamp ?? 0);
            entry.status = 'posted';
          }
        }
      } catch (err) {
        console.error(`[Monitor] Verify-all @${author.username} failed: ${err instanceof Error ? err.message : String(err)}`);
        entry.status = 'failed';
      }
      entries.push(entry);
    }

    return { channelId, entries };
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.getEffectiveIntervalMinutes() * 60_000);
    const authorCount = this.db.listMonitorGuilds()
      .reduce((sum, guildId) => sum + this.db.listMonitorAuthors(guildId).length, 0);
    console.log(`[Monitor] Started (${this.getEffectiveIntervalMinutes()} min interval, ${authorCount} author(s))`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refresh(): void {
    this.stop();
    this.start();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const guildId of this.db.listMonitorGuilds()) {
        const channelId = this.getChannelId(guildId);
        for (const author of this.db.listMonitorAuthors(guildId)) {
          try {
            await this.pollAuthor(author, guildId, channelId);
          } catch (err) {
            console.error(`[Monitor] Poll @${author.username} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private loadHashtags(): string[] {
    try {
      return parseHashtagFile(readFileSync(getHashtagFile(), 'utf8'));
    } catch {
      return [];
    }
  }

  private async tweetPassesFilter(tweet: MonitorTweet, author: MonitorAuthorRow, hashtags: string[]): Promise<boolean> {
    const kind = tweetKind(tweet);
    const allowed = kind === 'post' ? author.include_posts : kind === 'reply' ? author.include_replies : author.include_reposts;
    if (!allowed) return false;

    if (hasMedia(tweet)) {
      return hashtags.length === 0 || hasConfiguredHashtag(tweet, hashtags);
    }

    if (!author.media_only) {
      if (hashtags.length === 0) return true;
      if (hasConfiguredHashtag(tweet, hashtags)) return true;
      if (kind === 'reply') {
        const parent = await fetchParent(tweet);
        return !!parent && hasConfiguredHashtag(parent, hashtags);
      }
      return false;
    }

    if (kind !== 'reply' || !tweet.replying_to?.status) return false;
    const parent = await fetchParent(tweet);
    if (!parent || !hasMedia(parent)) return false;
    return hashtags.length === 0 || hasConfiguredHashtag(tweet, hashtags) || hasConfiguredHashtag(parent, hashtags);
  }

  private async fetchStatuses(username: string, author: MonitorAuthorRow): Promise<MonitorTweet[]> {
    const hashtags = this.loadHashtags();
    const res = await axios.get(`${API_BASE}/${encodeURIComponent(username)}/statuses`, {
      params: {
        count: getMonitorPageSize(),
        ...(author.include_replies ? { with_replies: 1 } : {}),
      },
      timeout: 20000,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      validateStatus: (s) => s === 200 || s === 204 || s === 404,
    });
    if (res.status === 204) return [];
    if (res.status === 404) throw new Error('handle not found');
    const data = res.data as { code?: number; results?: unknown[] } | undefined;
    if (!data || data.code !== 200 || !Array.isArray(data.results)) return [];
    const tweets = data.results.filter((r): r is MonitorTweet =>
      !!r && typeof r === 'object' && (r as MonitorTweet).type === 'status');
    const passed: MonitorTweet[] = [];
    for (const tweet of tweets) {
      if (await this.tweetPassesFilter(tweet, author, hashtags)) passed.push(tweet);
    }
    return passed;
  }

  private async pollAuthor(author: MonitorAuthorRow, guildId: string, channelId: string | null): Promise<void> {
    const tweets = await this.fetchStatuses(author.username, author);
    if (tweets.length === 0) return;

    const newest = tweets[0];
    const newestId = String(newest.id);
    const newestTs = newest.created_timestamp ?? 0;
    const newestIdentity = tweetIdentity(newest);
    const newestAuthorId = newestIdentity.id;
    const newestAuthorName = newestIdentity.screen_name;

    if (author.user_id && newestAuthorId && author.user_id !== newestAuthorId) {
      return;
    }

    if (author.user_id && !newestAuthorId) {
      return;
    }

    if (!author.user_id && newestAuthorId) {
      this.db.updateMonitorAuthorUserId(guildId, author.username, newestAuthorId);
      author.user_id = newestAuthorId;
    }

    if (author.user_id && newestAuthorName && newestAuthorName !== author.username) {
      if (this.db.renameMonitorAuthor(guildId, author.username, newestAuthorName)) {
        author.username = newestAuthorName;
      } else {
        return;
      }
    }

    if (author.last_tweet_id == null) {
      this.db.updateMonitorAuthorCursor(guildId, author.username, newestId, newestTs);
      console.log(`[Monitor] @${author.username}: baselined at ${newestId} (no relay on first poll)`);
      return;
    }

    const cursorIdx = tweets.findIndex((t) => String(t.id) === author.last_tweet_id);
    const newTweets = cursorIdx !== -1
      ? tweets.slice(0, cursorIdx)
      : author.last_tweet_ts != null
        ? tweets.filter((t) => (t.created_timestamp ?? 0) > author.last_tweet_ts!)
        : tweets;

    let relayed = 0;
    const maxCatchup = getMaxCatchup();
    for (const tweet of newTweets) {
      if (relayed >= maxCatchup) break; // ponytail: hard cap; overflow only lost on bursts > cap between polls
      if (!channelId) continue;
      try {
        await this.relayTweet(tweet, author.username, channelId, guildId);
        relayed++;
      } catch (err) {
        console.error(`[Monitor] Relay @${author.username}/${tweet.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.db.updateMonitorAuthorCursor(guildId, author.username, newestId, newestTs);
    if (relayed > 0) {
      console.log(`[Monitor] @${author.username}: ${relayed} new post(s) relayed, cursor at ${newestId}`);
    }
  }

  private async relayTweet(tweet: MonitorTweet, username: string, channelId: string, guildId: string): Promise<void> {
    const tweetId = String(tweet.id);
    const rawLink = tweet.url || `https://x.com/${username}/status/${tweetId}`;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`target channel ${channelId} is not available`);
    }
    const target = channel as TextChannel;

    let lastErr: unknown = null;
    for (const fixer of this.getFixers(guildId)) {
      const fixed = swapDomain(rawLink, fixer);
      try {
        await target.send(fixed);
        console.log(`[Monitor] Relayed @${username}/${tweetId} via ${fixer}`);
        return;
      } catch (err) {
        lastErr = err;
      }
    }

    try {
      await target.send(rawLink);
      console.log(`[Monitor] Relayed @${username}/${tweetId} via raw link`);
      return;
    } catch {
      // swallow — lastErr carries the original failure
    }
    throw lastErr ?? new Error('all fixers failed');
  }
}
