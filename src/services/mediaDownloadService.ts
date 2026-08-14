import path from 'path';
import crypto from 'crypto';
import * as fs from 'fs';
import axios from 'axios';
import { Message, Client } from 'discord.js';
import { FileService, sanitize } from './fileService';
import { DatabaseService, FileType } from './databaseService';
import { formatBytes, extractEmojiIds, extractMediaFromMessage, MediaEntry, MediaCategory, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, isDiscordCdnUrl } from '../utils/mediaUtils';
import { MediaConfig, DownloadProgress } from '../types';
import { isCancelled } from './cancelManager';
import { MegaService } from './megaService';
import { DeferredDownloadQueue, DeferredEntry } from './deferredDownloadQueue';
import { StorageService } from './storageService';
import { FolderRenameLogger } from '../utils/folderRenameLogger';
import { showRenamePopup } from '../utils/folderRenamePopup';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const EMBED_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov', 'svg', 'bmp', 'ico', 'avi', 'mkv', 'flv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

const DIRECT_MEDIA_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov', 'svg', 'bmp', 'ico', 'avi', 'mkv', 'flv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'pdf']);

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac',
};

function mimeToExt(mime: string | null): string {
  return (mime && MIME_EXT[mime]) || 'dat';
}

function detectExtFromBuffer(buffer: Buffer): string | null {
  const len = buffer.length;
  if (len < 8) {
    if (len >= 4 && buffer[0] === 0 && buffer[1] === 0 && (buffer[2] === 1 || buffer[2] === 2) && buffer[3] === 0) return 'ico';
    if (len >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
    if (len >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) return 'bmp';
    return null;
  }

  const hex = buffer.toString('hex', 0, 16);

  if (hex.startsWith('89504e470d0a1a0a')) return 'png';
  if (hex.startsWith('47494638373661') || hex.startsWith('47494638393961')) return 'gif';
  if (hex.startsWith('52494646') && hex.length >= 24 && hex.slice(16, 24) === '57454250') return 'webp';
  if (hex.startsWith('25504446')) return 'pdf';
  if (hex.startsWith('1a45dfa3')) {
    const body = buffer.toString('ascii', 0, Math.min(len, 200));
    return body.includes('matroska') ? 'mkv' : 'webm';
  }
  if (hex.startsWith('464c56')) return 'flv';
  if (hex.startsWith('494433')) return 'mp3';
  if (hex.startsWith('4f676753')) return 'ogg';
  if (hex.startsWith('664c6143')) return 'flac';

  if (hex.startsWith('52494646')) {
    const riffType = buffer.toString('ascii', 8, 12);
    if (riffType === 'AVI ') return 'avi';
    if (riffType === 'WAVE') return 'wav';
  }

  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'mov';
    if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return 'm4a';
    return 'mp4';
  }

  const head = buffer.toString('utf8', 0, Math.min(len, 20)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!DOCTYPE')) {
    if (buffer.toString('utf8', 0, Math.min(len, 200)).toLowerCase().includes('<svg')) return 'svg';
  }

  if (len >= 2 && buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return 'mp3';

  return null;
}

function filenameFromUrl(url: string): string {
  try {
    const basename = new URL(url).pathname.split('/').pop() || 'unknown';
    return basename || 'unknown';
  } catch {
    return 'unknown';
  }
}

function extFromUrl(url: string, fallback: string): string {
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() || '';
    if (EMBED_EXTS.includes(ext)) return ext;
  } catch {}
  return fallback;
}

async function scrapeUrlForMedia(url: string): Promise<{ url: string; type: 'video' | 'image' }[]> {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': BROWSER_UA },
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const results: { url: string; type: 'video' | 'image' }[] = [];

    const ogVideoProps = [
      /<meta[^>]+property="og:video:secure_url"[^>]+content="([^"]+)"[^>]*>/i,
      /<meta[^>]+property="og:video:url"[^>]+content="([^"]+)"[^>]*>/i,
      /<meta[^>]+property="og:video"[^>]+content="([^"]+)"[^>]*>/i,
    ];
    for (const re of ogVideoProps) {
      const m = html.match(re);
      if (m) { results.push({ url: m[1], type: 'video' }); break; }
    }

    const twPatterns = [
      /<meta[^>]+name="twitter:player:stream"[^>]+content="([^"]+)"[^>]*>/i,
      /<meta[^>]+name="twitter:player"[^>]+content="([^"]+)"[^>]*>/i,
    ];
    for (const re of twPatterns) {
      const m = html.match(re);
      if (m) { results.push({ url: m[1], type: 'video' }); break; }
    }

    if (results.length === 0) {
      const ogImageProps = [
        /<meta[^>]+property="og:image:secure_url"[^>]+content="([^"]+)"[^>]*>/i,
        /<meta[^>]+property="og:image:url"[^>]+content="([^"]+)"[^>]*>/i,
        /<meta[^>]+property="og:image"[^>]+content="([^"]+)"[^>]*>/i,
        /<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"[^>]*>/i,
      ];
      for (const re of ogImageProps) {
        const m = html.match(re);
        if (m) { results.push({ url: m[1], type: 'image' }); break; }
      }
    }

    return results;
  } catch {
    return [];
  }
}

function shouldSkipScrape(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes('discord') || host.includes('cdn.discordapp');
  } catch {
    return false;
  }
}

function setFileTimestamps(filePath: string, timestampMs: number): void {
  try {
    const date = new Date(timestampMs);
    fs.utimesSync(filePath, date, date);
  } catch {
    // non-critical
  }
}


export class MediaDownloadService {
  private fileService: FileService;
  private db: DatabaseService;
  private onProgress: (progress: DownloadProgress) => void;
  private seenHashes: Set<string>;
  private scrapedUrls: Set<string>;
  private downloadDir: string;
  private retries: number;
  private loggedKeys: Set<string>;

  public megaService?: MegaService;
  public deferredQueue?: DeferredDownloadQueue;
  public storageService?: StorageService;
  public renameLogger: FolderRenameLogger;
  private processingQueue = false;

  constructor(fileService: FileService, db: DatabaseService, onProgress: (progress: DownloadProgress) => void, downloadDir?: string, retries?: number, megaService?: MegaService, deferredQueue?: DeferredDownloadQueue, storageService?: StorageService) {
    this.megaService = megaService;
    this.deferredQueue = deferredQueue;
    this.storageService = storageService;
    this.fileService = fileService;
    this.db = db;
    this.onProgress = onProgress;
    this.seenHashes = new Set();
    this.scrapedUrls = new Set();
    this.downloadDir = downloadDir || process.env.DOWNLOAD_DIR || './downloads';
    this.retries = retries ?? parseInt(process.env.DOWNLOAD_RETRIES || '3', 10);
    this.loggedKeys = this.loadLoggedKeys();
    this.renameLogger = new FolderRenameLogger(this.downloadDir);
  }

  private resolveBaseDir(guildName: string, channelName: string, parentChannelName?: string): string {
    if (this.storageService) {
      return this.storageService.getBaseDir(guildName, channelName, parentChannelName);
    }
    return this.fileService.getBaseDir(guildName, channelName, parentChannelName);
  }

  private getRoot(): string {
    if (this.storageService) return this.storageService.getActiveRoot();
    return this.downloadDir;
  }

  async renameIfNeeded(
    guildId: string,
    channelId: string,
    guildName: string,
    channelName: string,
    parentChannelName?: string | null,
  ): Promise<string> {
    const sGuild = sanitize(guildName);
    const sChannel = sanitize(channelName);
    const sParent = parentChannelName ? sanitize(parentChannelName) : undefined;

    // Build expected path from current names
    const expectedParts = [this.getRoot(), sGuild];
    if (sParent) expectedParts.push(sParent);
    expectedParts.push(sChannel);
    const expectedDir = path.join(...expectedParts);

    const state = this.db.getChannelState(guildId, channelId);

    if (fs.existsSync(expectedDir)) {
      // Folder exists at expected location — ensure _meta.json is present
      const meta = this.fileService.readMeta(expectedDir);
      if (!meta || meta.channelId !== channelId) {
        this.fileService.writeMeta(expectedDir, channelId, guildId, sParent ?? null);
      }
      // Update DB names even if no rename needed (backfill for existing rows)
      if (state && !state.channel_name) {
        this.db.updateChannelState(guildId, channelId, state.oldest_message_id || '', state.newest_message_id || '', sGuild, sChannel, sParent ?? null);
      }
      return expectedDir;
    }

    // Expected folder doesn't exist — try to find by channel ID
    const guildDir = path.join(this.getRoot(), sGuild);
    const foundDir = this.fileService.findFolderByChannelId(guildDir, channelId);

    if (foundDir) {
      // Found existing folder with matching channel ID — rename it
      const oldMeta = this.fileService.readMeta(foundDir);
      const oldName = path.basename(foundDir);

      // Determine old parent from found path
      const relFromGuild = path.relative(guildDir, foundDir);
      const relParts = relFromGuild.split(/[/\\]/);
      const oldParentName = relParts.length > 1 ? relParts[0] : undefined;

      try {
        fs.renameSync(foundDir, expectedDir);
        console.log(`[Rename] ${oldName} → ${sChannel} (guild: ${sGuild})`);
      } catch (err) {
        console.error(`[Rename] Failed to rename ${foundDir} → ${expectedDir}: ${err instanceof Error ? err.message : err}`);
        // Fall through — create new folder
      }

      // Rename on MEGA
      if (this.megaService?.isConnected()) {
        const oldMegaParts = ['downloads', sGuild];
        if (oldParentName) oldMegaParts.push(oldParentName);
        oldMegaParts.push(oldName);
        const oldMegaPath = oldMegaParts.join('/');
        const newMegaParts = ['downloads', sGuild];
        if (sParent) newMegaParts.push(sParent);
        newMegaParts.push(sChannel);
        const newMegaPath = newMegaParts.join('/');
        await this.megaService.renameRemoteFolder(oldMegaPath, newMegaPath);
      }

      // Log and popup
      this.renameLogger.logRename(
        guildName,
        oldMeta?.parentChannelId ? oldName : oldName,
        channelName,
        parentChannelName || undefined,
        oldParentName,
      );
      showRenamePopup(this.renameLogger.getPopupMessage(), this.renameLogger.getLogPath());

      // Update _meta.json and DB
      this.fileService.writeMeta(expectedDir, channelId, guildId, sParent ?? null);
      if (state) {
        this.db.updateChannelState(guildId, channelId, state.oldest_message_id || '', state.newest_message_id || '', sGuild, sChannel, sParent ?? null);
      }
      return expectedDir;
    }

    // No existing folder found — create new
    this.fileService.ensureDir(expectedDir);
    this.fileService.writeMeta(expectedDir, channelId, guildId, sParent ?? null);
    return expectedDir;
  }

  private logPath(): string {
    return path.resolve(this.downloadDir, '..', '.download-log.jsonl');
  }

  private loadLoggedKeys(): Set<string> {
    const keys = new Set<string>();
    try {
      const logFile = this.logPath();
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.filename && entry.reason) keys.add(`${entry.filename}|${entry.reason}`);
          } catch {}
        }
      }
    } catch {}
    return keys;
  }

  async downloadAllMedia(
    messages: Message[],
    guildName: string,
    channelName: string,
    mediaConfig?: MediaConfig,
    guildId?: string,
    channelId?: string,
    onStatus?: (msg: string) => void,
    parentChannelName?: string,
    concurrency = 3,
    skipUpload = false,
    resolvedBaseDir?: string,
  ): Promise<{ mediaCount: number; outputPath: string; totalBytes: number; megaBasePath: string }> {
    const megaBasePath = parentChannelName
      ? `downloads/${sanitize(guildName)}/${sanitize(parentChannelName || '')}/${sanitize(channelName)}`
      : `downloads/${sanitize(guildName)}/${sanitize(channelName)}`;

    const baseDir = resolvedBaseDir || this.resolveBaseDir(guildName, channelName, parentChannelName);

    const avatarResult = await this.downloadAvatars(messages, baseDir, megaBasePath, concurrency, guildId, channelId);
    if (channelId && isCancelled(channelId)) return { mediaCount: 0, outputPath: baseDir, totalBytes: 0, megaBasePath };

    if (onStatus) onStatus('Downloading media files...');
    const mediaResult = await this.downloadAttachments(messages, baseDir, megaBasePath, mediaConfig, guildId, channelId, channelName, concurrency);
    if (channelId && isCancelled(channelId)) return { mediaCount: mediaResult.count, outputPath: baseDir, totalBytes: mediaResult.bytes, megaBasePath };

    const emojiResult = await this.downloadEmojis(messages, baseDir, megaBasePath, concurrency, guildId, channelId);

    if (!skipUpload && this.megaService?.isConnected()) {
      await this.megaService.uploadDirectoryAndClean(baseDir, megaBasePath);
    }

    const stats = this.fileService.getDownloadStats(baseDir);
    const lines = [
      `Server: ${guildName}`,
      `Channel: ${channelName}`,
      `Messages scanned: ${messages.length}`,
      `Media files downloaded: ${mediaResult.count}`,
      `Avatars downloaded: ${avatarResult.count}`,
      `Emojis downloaded: ${emojiResult.count}`,
      `Total files: ${stats.fileCount}`,
      `Total size: ${formatBytes(stats.totalSize)}`,
      `Output: ${baseDir}`,
      `Downloaded: ${new Date().toISOString()}`,
    ];
    this.fileService.writeSummary(baseDir, lines.join('\n'));

    return { mediaCount: mediaResult.count + avatarResult.count + emojiResult.count, outputPath: baseDir, totalBytes: mediaResult.bytes + avatarResult.bytes + emojiResult.bytes, megaBasePath };
  }

  async downloadMediaOnly(
    messages: Message[],
    guildName: string,
    channelName: string,
    mediaConfig?: MediaConfig,
    guildId?: string,
    channelId?: string,
    parentChannelName?: string,
    concurrency = 3,
    skipUpload = false,
  ): Promise<{ mediaCount: number; outputPath: string; totalBytes: number }> {
    const baseDir = this.resolveBaseDir(guildName, channelName, parentChannelName);
    const mediaResult = await this.downloadAttachments(messages, baseDir, '', mediaConfig, guildId, channelId, channelName, concurrency);

    const stats = this.fileService.getDownloadStats(baseDir);
    const lines = [
      `Server: ${guildName}`,
      `Channel: ${channelName}`,
      `Messages scanned: ${messages.length}`,
      `Media files downloaded: ${mediaResult.count}`,
      `Total files: ${stats.fileCount}`,
      `Total size: ${formatBytes(stats.totalSize)}`,
      `Output: ${baseDir}`,
      `Downloaded: ${new Date().toISOString()}`,
    ];
    this.fileService.writeSummary(baseDir, lines.join('\n'));

    return { mediaCount: mediaResult.count, outputPath: baseDir, totalBytes: mediaResult.bytes };
  }

  async downloadNewMessageMedia(
    message: Message,
    guildName: string,
    channelName: string,
    mediaConfig?: MediaConfig,
    parentChannelName?: string,
    resolvedBaseDir?: string,
  ): Promise<number> {
    // If MEGA exists but isn't connected and we have a deferred queue, enqueue for later
    // Skip re-enqueue if we're currently draining the queue (e.g. fallback flush)
    if (!this.processingQueue && this.megaService && !this.megaService.isConnected() && this.deferredQueue) {
      this.deferredQueue.enqueue({
        guildId: message.guild?.id || '',
        channelId: message.channel.id,
        messageId: message.id,
        guildName,
        channelName,
        parentChannelName,
        mediaConfig: mediaConfig || { images: true, videos: true, audio: true, other: true },
        timestamp: Date.now(),
      });
      console.log(`[Auto] Deferred download for ${channelName} (MEGA not connected)`);
      return 0;
    }

    const baseDir = resolvedBaseDir || this.resolveBaseDir(guildName, channelName, parentChannelName);
    const result = await this.downloadMessageMedia(message, baseDir, 0, mediaConfig);

    return result.count;
  }

  getSeenHashes(): Set<string> {
    return this.seenHashes;
  }

  clearSeenHashes(): void {
    this.seenHashes.clear();
  }

  async processDeferredQueue(client: Client): Promise<void> {
    if (this.processingQueue || !this.deferredQueue) return;
    this.processingQueue = true;
    const entries = this.deferredQueue.list();
    if (entries.length === 0) {
      this.processingQueue = false;
      return;
    }
    console.log(`[Queue] Processing ${entries.length} deferred auto-download(s)...`);
    for (const entry of entries) {
      try {
        const channel = await client.channels.fetch(entry.channelId).catch(() => null);
        if (!channel) {
          console.log(`[Queue] Channel ${entry.channelId} not found, removing entry`);
          this.deferredQueue.remove(entry);
          continue;
        }
        const channelAny = channel as any;
        if (!channelAny.messages?.fetch) {
          console.log(`[Queue] Cannot fetch messages in channel ${entry.channelId}, removing entry`);
          this.deferredQueue.remove(entry);
          continue;
        }
        const message = await channelAny.messages.fetch(entry.messageId).catch(() => null);
        if (!message) {
          console.log(`[Queue] Message ${entry.messageId} not found (deleted?), removing entry`);
          this.deferredQueue.remove(entry);
          continue;
        }

        const guildId = message.guild?.id || entry.guildId;
        const channelId = entry.channelId;
        const baseDir = await this.renameIfNeeded(
          guildId, channelId,
          entry.guildName, entry.channelName, entry.parentChannelName,
        );

        const count = await this.downloadNewMessageMedia(
          message as Message,
          entry.guildName,
          entry.channelName,
          entry.mediaConfig,
          entry.parentChannelName,
          baseDir,
        );
        console.log(`[Queue] Processed deferred message ${entry.messageId}: ${count} file(s)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Queue] Error processing deferred message ${entry.messageId}: ${msg}`);
      }
      this.deferredQueue.remove(entry);
      // Rate-limit: 1s between fetches to avoid hitting Discord rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
    this.processingQueue = false;
    const remaining = this.deferredQueue.count();
    if (remaining > 0) {
      console.log(`[Queue] ${remaining} entry(s) still pending after processing cycle`);
    } else {
      console.log(`[Queue] All deferred auto-downloads processed`);
    }
  }

  private logDownloadEvent(entry: MediaEntry, reason: string, channel?: string): void {
    try {
      const key = `${entry.filename}|${reason}`;
      if (this.loggedKeys.has(key)) return;
      this.loggedKeys.add(key);

      const ts = entry.timestamp
        ? new Date(entry.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Manila', hour12: false })
        : 'unknown';
      const logLine = JSON.stringify({
        url: entry.url,
        reason,
        messageTimestamp: entry.timestamp || null,
        messageTimestampLocal: ts,
        filename: entry.filename,
        category: entry.category,
        type: entry.type,
        channel: channel || null,
        loggedAt: new Date().toISOString(),
      }) + '\n';
      fs.appendFileSync(this.logPath(), logLine, 'utf-8');
    } catch {
      // non-critical; silently ignore
    }
  }

  private async downloadAvatars(
    messages: Message[],
    baseDir: string,
    megaBasePath: string,
    concurrency = 3,
    guildId?: string,
    channelId?: string,
  ): Promise<{ count: number; bytes: number }> {
    const avatarSet = new Set<string>();

    for (const msg of messages) {
      const author = msg.author;
      if (author?.id && author.avatar) {
        avatarSet.add(`${author.id}/${author.avatar}`);
      }
    }

    const avatars = Array.from(avatarSet);
    this.onProgress({
      stage: 'avatars',
      current: 0,
      total: avatars.length,
      message: `Downloading ${avatars.length} avatars...`,
    });

    let downloaded = 0;
    let totalBytes = 0;

    for (let i = 0; i < avatars.length; i += concurrency) {
      const batch = avatars.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (idAndAvatar) => {
          const [userId, avatarHash] = idAndAvatar.split('/');
          const url = `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.webp?size=80`;

          const avatarDir = this.fileService.getAvatarDir(baseDir);
          const userDir = path.join(avatarDir, userId);

          const result = await this.tryDownload(
            url, null, userDir, avatarHash, 'images', 'webp', guildId, channelId, undefined,
            'avatar',
          );
          return result;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 'downloaded') {
          downloaded++;
          totalBytes += r.value.bytes;
        }
        this.onProgress({
          stage: 'avatars',
          current: downloaded,
          total: avatars.length,
          message: `Downloaded avatar ${downloaded}/${avatars.length}`,
        });
      }
    }

    return { count: downloaded, bytes: totalBytes };
  }

  private async supplementEmbedScrapes(
    messages: Message[],
    baseIndex: number,
    mediaConfig?: MediaConfig
  ): Promise<MediaEntry[]> {
    const extra: MediaEntry[] = [];

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      for (const embed of msg.embeds) {
        if (!embed.url) continue;
        if (shouldSkipScrape(embed.url)) continue;

        const normUrl = embed.url.split('?')[0].split('#')[0];
        if (this.scrapedUrls.has(normUrl)) continue;
        this.scrapedUrls.add(normUrl);

        const urlExt = normUrl.split('.').pop()?.toLowerCase() || '';

        if (DIRECT_MEDIA_EXTS.has(urlExt)) {
          const category: MediaCategory = IMAGE_EXTS.includes(urlExt) || urlExt === 'svg'
            ? 'images' : VIDEO_EXTS.includes(urlExt) ? 'videos' : AUDIO_EXTS.includes(urlExt) ? 'audio' : 'other';

          if (mediaConfig) {
            if (category === 'images' && !mediaConfig.images) continue;
            if (category === 'videos' && !mediaConfig.videos) continue;
            if (category === 'audio' && !mediaConfig.audio) continue;
            if (category === 'other' && !mediaConfig.other) continue;
          }

          const extFallback = IMAGE_EXTS.includes(urlExt) ? 'jpg' : 'mp4';

          extra.push({
            url: embed.url,
            proxyUrl: null,
            index: baseIndex + mi,
            filename: filenameFromUrl(embed.url),
            category,
            type: category === 'images' ? 'embed-image' : 'embed-video',
            ext: extFromUrl(embed.url, extFallback),
            timestamp: msg.createdTimestamp,
          });
          continue;
        }

        const scraped = await scrapeUrlForMedia(embed.url);
        for (const s of scraped) {
          const category: MediaCategory = s.type === 'video' ? 'videos' : 'images';
          const ext = extFromUrl(s.url, s.type === 'video' ? 'mp4' : 'jpg');

          if (mediaConfig) {
            if (s.type === 'video' && !mediaConfig.videos) continue;
            if (s.type === 'image' && !mediaConfig.images) continue;
          }

          extra.push({
            url: s.url,
            proxyUrl: null,
            index: baseIndex + mi,
            filename: filenameFromUrl(s.url),
            category,
            type: s.type === 'video' ? 'embed-video' : 'embed-image',
            ext,
            timestamp: msg.createdTimestamp,
          });
        }
      }
    }

    return extra;
  }

  private async downloadEntryList(
    entries: MediaEntry[],
    stage: string,
    baseDir: string,
    megaBasePath: string,
    guildId?: string,
    channelId?: string,
    channelName?: string,
    concurrency = 3,
  ): Promise<{ count: number; bytes: number }> {
    const ch = channelName ? ` from #${channelName}` : '';
    if (entries.length === 0) {
      this.onProgress({ stage, current: 0, total: 0, message: `No ${stage} found${ch}` });
      return { count: 0, bytes: 0 };
    }

    this.onProgress({
      stage,
      current: 0,
      total: entries.length,
      message: `Downloading ${entries.length} ${stage}${ch}...`,
    });

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let totalBytes = 0;

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);

      if (channelId && isCancelled(channelId)) {
        this.onProgress({ stage, current: downloaded, total: entries.length, message: 'Cancelled' });
        return { count: downloaded, bytes: totalBytes };
      }

      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const mediaDir = this.fileService.getMediaDir(baseDir, entry.category);
          const filename = this.fileService.buildFilename(entry.filename, entry.timestamp);

          return this.downloadWithDedup(
            entry.url,
            entry.proxyUrl,
            mediaDir,
            filename,
            entry.category,
            entry.ext,
            guildId,
            channelId,
            entry.index,
            entry.timestamp,
            'media',
          );
        })
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const entry = batch[j];
        const value = r.status === 'fulfilled' ? r.value : null;
        const success = value ? value.status : 'failed';

        if (success === 'downloaded') { downloaded++; totalBytes += value!.bytes; }
        else if (success === 'skipped') { skipped++; this.logDownloadEvent(entry, 'skipped (duplicate)', channelId); }
        else if (success === 'failed') { failed++; this.logDownloadEvent(entry, 'failed', channelId); }

        const entryName = entry.filename.split('/').pop() || entry.filename;
        this.onProgress({
          stage,
          current: downloaded,
          total: entries.length - skipped,
          message: success === 'downloaded'
            ? `Downloaded ${entryName} (${downloaded}/${entries.length - skipped}${skipped > 0 ? `, ${skipped} dupes` : ''})`
            : success === 'skipped'
              ? `Skipped ${entryName} (duplicate)`
              : `Failed ${entryName}`,
        });
      }
    }

    return { count: downloaded, bytes: totalBytes };
  }

  private async downloadAttachments(
    messages: Message[],
    baseDir: string,
    megaBasePath: string,
    mediaConfig?: MediaConfig,
    guildId?: string,
    channelId?: string,
    channelName?: string,
    concurrency = 3,
  ): Promise<{ count: number; bytes: number }> {
    const entries: MediaEntry[] = [];

    messages.forEach((msg, index) => {
      entries.push(...extractMediaFromMessage(msg, index, mediaConfig));
    });

    // mark embeds that already produced entries so supplementEmbedScrapes skips them
    for (const msg of messages) {
      for (const embed of msg.embeds) {
        if (embed.url && (embed.image?.url || embed.video?.url || embed.thumbnail?.url)) {
          this.scrapedUrls.add(embed.url.split('?')[0].split('#')[0]);
        }
      }
    }

    const scraped = await this.supplementEmbedScrapes(messages, 0, mediaConfig);
    entries.push(...scraped);

    if (entries.length === 0) {
      const ch = channelName ? ` from #${channelName}` : '';
      this.onProgress({
        stage: 'attachments',
        current: 0,
        total: 0,
        message: `No media found${ch}`,
      });
      return { count: 0, bytes: 0 };
    }

    const attachmentEntries = entries.filter(e => e.type === 'attachment');
    const embedEntries = entries.filter(e => e.type !== 'attachment');

    const attResult = await this.downloadEntryList(attachmentEntries, 'attachments', baseDir, megaBasePath, guildId, channelId, channelName, concurrency);
    const embedResult = await this.downloadEntryList(embedEntries, 'embeds', baseDir, megaBasePath, guildId, channelId, channelName, concurrency);

    return { count: attResult.count + embedResult.count, bytes: attResult.bytes + embedResult.bytes };
  }

  private async tryDownload(
    url: string,
    proxyUrl: string | null,
    outputDir: string,
    filename: string,
    category: string,
    ext: string,
    guildId?: string,
    channelId?: string,
    timestamp?: number,
    type: FileType = 'media',
  ): Promise<{ status: 'downloaded' | 'skipped' | 'failed'; bytes: number }> {
    const actualUrl = proxyUrl || url;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const response = await Promise.race([
          axios({
            method: 'GET',
            url: actualUrl,
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*', 'Referer': 'https://discord.com/' },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Download stalled (60s timeout)')), 60000)
          ),
        ]);

        const buffer = Buffer.from(response.data);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        const bytes = buffer.length;

        const memKey = `${hash}|${guildId || ''}|${channelId || ''}|${type}`;
        if (this.seenHashes.has(memKey)) {
          return { status: 'skipped', bytes: 0 };
        }

        if (guildId && channelId && this.db.hasFileHash(hash, guildId, channelId, type)) {
          // File already in DB — batch MEGA upload at end will handle any orphans
          return { status: 'skipped', bytes: 0 };
        }

        const detectedExt = detectExtFromBuffer(buffer);
        const finalExt = detectedExt || (EMBED_EXTS.includes(ext) ? ext : null) || mimeToExt(
          typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null
        ) || ext || 'dat';
        const finalName = `${filename}.${finalExt}`;
        let finalPath = path.join(outputDir, finalName);

        if (fs.existsSync(finalPath)) {
          const existingBuf = fs.readFileSync(finalPath);
          const existingHash = crypto.createHash('sha256').update(existingBuf).digest('hex');
          if (existingHash === hash) { return { status: 'skipped', bytes: 0 }; }
          const prefix = hash.slice(0, 8);
          finalPath = path.join(outputDir, `${filename}_${prefix}.${finalExt}`);
        }

        const storedName = path.basename(finalPath);
        this.fileService.ensureDir(outputDir);
        fs.writeFileSync(finalPath, buffer);

        if (timestamp) setFileTimestamps(finalPath, timestamp);

        // Commit hash to DB immediately after successful download (before batch MEGA upload)
        this.seenHashes.add(memKey);
        this.db.insertFileHash(hash, guildId || '', channelId || '', type, isDiscordCdnUrl(url) ? url : null, storedName, bytes, category === 'images' || category === 'videos' || category === 'audio' ? category : null);

        if (this.storageService && !this.storageService.isDriveAvailable()) {
          const relPath = path.relative(this.downloadDir, finalPath).replace(/\\/g, '/');
          this.storageService.enqueueMigration(relPath, bytes);
        }

        return { status: 'downloaded', bytes };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (channelId && isCancelled(channelId)) return { status: 'failed', bytes: 0 };
        if (attempt < this.retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    return { status: 'failed', bytes: 0 };
  }

  private async downloadWithDedup(
    url: string,
    proxyUrl: string | null,
    outputDir: string,
    filename: string,
    category: string,
    ext: string,
    guildId?: string,
    channelId?: string,
    messageIndex?: number,
    timestamp?: number,
    type: FileType = 'media',
  ): Promise<{ status: 'downloaded' | 'skipped' | 'failed'; bytes: number }> {
    const result = await this.tryDownload(proxyUrl || url, null, outputDir, filename, category, ext, guildId, channelId, timestamp, type);
    if (result.status !== 'failed' || !proxyUrl || url === proxyUrl) return result;
    return this.tryDownload(url, null, outputDir, filename, category, ext, guildId, channelId, timestamp, type);
  }

  private async downloadEmojis(
    messages: Message[],
    baseDir: string,
    megaBasePath: string,
    concurrency = 3,
    guildId?: string,
    channelId?: string,
  ): Promise<{ count: number; bytes: number }> {
    const emojiIds = new Set<string>();

    for (const msg of messages) {
      const ids = extractEmojiIds(msg.content || '');
      ids.forEach(id => emojiIds.add(id));

      for (const reaction of msg.reactions.cache.values()) {
        if (reaction.emoji.id) emojiIds.add(reaction.emoji.id);
      }
    }

    const emojis = Array.from(emojiIds);
    if (emojis.length === 0) return { count: 0, bytes: 0 };

    this.onProgress({
      stage: 'emojis',
      current: 0,
      total: emojis.length,
      message: `Downloading ${emojis.length} emojis...`,
    });

    let downloaded = 0;
    let totalBytes = 0;

    for (let i = 0; i < emojis.length; i += concurrency) {
      const batch = emojis.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (emojiId) => {
          const url = `https://cdn.discordapp.com/emojis/${emojiId}.webp?animated=true`;

          const emojiDir = this.fileService.getEmojiDir(baseDir);

          const result = await this.tryDownload(
            url, null, emojiDir, emojiId, 'images', 'webp', guildId, channelId, undefined,
            'emoji',
          );
          return result;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 'downloaded') {
          downloaded++;
          totalBytes += r.value.bytes;
        }
        this.onProgress({
          stage: 'emojis',
          current: downloaded,
          total: emojis.length,
          message: `Downloaded emoji ${downloaded}/${emojis.length}`,
        });
      }
    }

    return { count: downloaded, bytes: totalBytes };
  }

  private async downloadMessageMedia(
    message: Message,
    baseDir: string,
    index: number,
    mediaConfig?: MediaConfig,
  ): Promise<{ count: number; bytes: number }> {
    const entries = extractMediaFromMessage(message, index, mediaConfig);

    // mark embeds that already produced entries so supplementEmbedScrapes skips them
    for (const embed of message.embeds) {
      if (embed.url && (embed.image?.url || embed.video?.url || embed.thumbnail?.url)) {
        this.scrapedUrls.add(embed.url.split('?')[0].split('#')[0]);
      }
    }

    const scraped = await this.supplementEmbedScrapes([message], index, mediaConfig);
    entries.push(...scraped);

    const attachmentEntries = entries.filter(e => e.type === 'attachment');
    const embedEntries = entries.filter(e => e.type !== 'attachment');

    // For auto-download, we don't have megaBasePath easily, so construct it
    const guildId = message.guild?.id;
    const channelId = message.channel.id;
    const guildName = message.guild?.name || 'Unknown';
    const channelName = (message.channel as any).name || channelId;

    const megaBasePath = `downloads/${sanitize(guildName)}/${sanitize(channelName)}`;

    const attResult = await this.downloadEntryList(attachmentEntries, 'attachments', baseDir, megaBasePath, guildId, channelId, undefined, 3);
    const embedResult = await this.downloadEntryList(embedEntries, 'embeds', baseDir, megaBasePath, guildId, channelId, undefined, 3);

    return { count: attResult.count + embedResult.count, bytes: attResult.bytes + embedResult.bytes };
  }
}
