import path from 'path';
import crypto from 'crypto';
import * as fs from 'fs';
import axios from 'axios';
import { Message } from 'discord.js';
import { FileService, sanitize } from './fileService';
import { DatabaseService } from './databaseService';
import { formatBytes, extractEmojiIds, extractMediaFromMessage, MediaEntry, MediaCategory, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } from '../utils/mediaUtils';
import { MediaConfig, DownloadProgress } from '../types';
import { isCancelled } from './cancelManager';
import { SessionLogger } from '../utils/sessionLogger';
import { MegaService } from './megaService';

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

  private megaService?: MegaService;

  constructor(fileService: FileService, db: DatabaseService, onProgress: (progress: DownloadProgress) => void, downloadDir?: string, retries?: number, megaService?: MegaService) {
    this.megaService = megaService;
    this.fileService = fileService;
    this.db = db;
    this.onProgress = onProgress;
    this.seenHashes = new Set();
    this.scrapedUrls = new Set();
    this.downloadDir = downloadDir || process.env.DOWNLOAD_DIR || './downloads';
    this.retries = retries ?? parseInt(process.env.DOWNLOAD_RETRIES || '3', 10);
    this.loggedKeys = this.loadLoggedKeys();
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
    logger?: SessionLogger,
  ): Promise<{ mediaCount: number; outputPath: string; totalBytes: number }> {
    const remotePath = parentChannelName
      ? `downloads/${sanitize(guildName)}/${sanitize(parentChannelName || '')}/${sanitize(channelName)}`
      : `downloads/${sanitize(guildName)}/${sanitize(channelName)}`;

    logger?.log(`=== Download session for #${channelName} ===`);
    logger?.log(`Messages to process: ${messages.length}`);

    const baseDir = this.fileService.getBaseDir(guildName, channelName, parentChannelName);

    const avatarResult = await this.downloadAvatars(messages, baseDir, concurrency);
    logger?.log(`Avatars: ${avatarResult.count} downloaded`);
    if (channelId && isCancelled(channelId)) return { mediaCount: 0, outputPath: baseDir, totalBytes: 0 };

    if (onStatus) onStatus('Downloading media files...');
    const mediaResult = await this.downloadAttachments(messages, baseDir, mediaConfig, guildId, channelId, channelName, concurrency, logger);
    if (channelId && isCancelled(channelId)) return { mediaCount: mediaResult.count, outputPath: baseDir, totalBytes: mediaResult.bytes };

    const emojiResult = await this.downloadEmojis(messages, baseDir, concurrency);
    logger?.log(`Emojis: ${emojiResult.count} downloaded`);

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
    logger?.log(`Session summary: ${mediaResult.count} media, ${avatarResult.count} avatars, ${emojiResult.count} emojis (${formatBytes(stats.totalSize)})`);

    this.megaService?.uploadDirectory(baseDir, remotePath).catch(() => {});

    return { mediaCount: mediaResult.count + avatarResult.count + emojiResult.count, outputPath: baseDir, totalBytes: mediaResult.bytes + avatarResult.bytes + emojiResult.bytes };
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
  ): Promise<{ mediaCount: number; outputPath: string; totalBytes: number }> {
    const remotePath = parentChannelName
      ? `downloads/${sanitize(guildName)}/${sanitize(parentChannelName || '')}/${sanitize(channelName)}`
      : `downloads/${sanitize(guildName)}/${sanitize(channelName)}`;

    const baseDir = this.fileService.getBaseDir(guildName, channelName, parentChannelName);
    const mediaResult = await this.downloadAttachments(messages, baseDir, mediaConfig, guildId, channelId, channelName, concurrency);

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

    this.megaService?.uploadDirectory(baseDir, remotePath).catch(() => {});

    return { mediaCount: mediaResult.count, outputPath: baseDir, totalBytes: mediaResult.bytes };
  }

  async downloadNewMessageMedia(
    message: Message,
    guildName: string,
    channelName: string,
    mediaConfig?: MediaConfig,
    parentChannelName?: string,
    logger?: SessionLogger,
  ): Promise<number> {
    const remotePath = parentChannelName
      ? `downloads/${sanitize(guildName)}/${sanitize(parentChannelName || '')}/${sanitize(channelName)}`
      : `downloads/${sanitize(guildName)}/${sanitize(channelName)}`;

    logger?.log(`Auto-download triggered: ${message.author.tag} sent a message in #${channelName}`);

    const baseDir = this.fileService.getBaseDir(guildName, channelName, parentChannelName);
    const result = await this.downloadMessageMedia(message, baseDir, 0, mediaConfig, logger);
    logger?.log(`Auto-downloaded ${result.count} file(s) from ${message.author.tag}`);

    if (result.count > 0) {
      this.megaService?.uploadDirectory(baseDir, remotePath).catch(() => {});
    }

    return result.count;
  }

  getSeenHashes(): Set<string> {
    return this.seenHashes;
  }

  clearSeenHashes(): void {
    this.seenHashes.clear();
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
    concurrency = 3,
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
          await this.fileService.downloadWithMime(url, null, userDir, avatarHash);
          return 0;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          downloaded++;
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
          const dummyName = category === 'images' ? 'image' : category === 'videos' ? 'video' : 'audio';

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
          const dummyName = s.type === 'video' ? 'video' : 'image';

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
    guildId?: string,
    channelId?: string,
    channelName?: string,
    concurrency = 3,
    logger?: SessionLogger,
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
    logger?.log(`Stage ${stage}: ${entries.length} files to process`);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let totalBytes = 0;

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);

      if (channelId && isCancelled(channelId)) {
        this.onProgress({ stage, current: downloaded, total: entries.length, message: 'Cancelled' });
        logger?.log(`Stage ${stage}: Cancelled after ${downloaded} files`);
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
            logger
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

    logger?.log(`Stage ${stage} done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
    return { count: downloaded, bytes: totalBytes };
  }

  private async downloadAttachments(
    messages: Message[],
    baseDir: string,
    mediaConfig?: MediaConfig,
    guildId?: string,
    channelId?: string,
    channelName?: string,
    concurrency = 3,
    logger?: SessionLogger,
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

    const attResult = await this.downloadEntryList(attachmentEntries, 'attachments', baseDir, guildId, channelId, channelName, concurrency, logger);
    const embedResult = await this.downloadEntryList(embedEntries, 'embeds', baseDir, guildId, channelId, channelName, concurrency, logger);

    return { count: attResult.count + embedResult.count, bytes: attResult.bytes + embedResult.bytes };
  }

  private async tryDownload(
    url: string,
    outputDir: string,
    filename: string,
    category: string,
    ext: string,
    guildId?: string,
    channelId?: string,
    timestamp?: number,
    logger?: SessionLogger,
  ): Promise<{ status: 'downloaded' | 'skipped' | 'failed'; bytes: number }> {
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      logger?.log(`Download attempt ${attempt}/${this.retries}: ${filename} <- ${url}`);
      try {
        const response = await Promise.race([
          axios({
            method: 'GET',
            url,
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

        if (this.seenHashes.has(hash)) { logger?.log(`Skipped ${filename} (in-memory duplicate)`); return { status: 'skipped', bytes: 0 }; }
        if (this.db.hasHash(hash)) { logger?.log(`Skipped ${filename} (already in DB)`); return { status: 'skipped', bytes: 0 }; }

        const finalExt = mimeToExt(
          typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null
        ) || ext;
        const finalName = `${filename}.${finalExt}`;
        let finalPath = path.join(outputDir, finalName);

        if (fs.existsSync(finalPath)) {
          const existingBuf = fs.readFileSync(finalPath);
          const existingHash = crypto.createHash('sha256').update(existingBuf).digest('hex');
          if (existingHash === hash) { logger?.log(`Skipped ${filename} (file content duplicate)`); return { status: 'skipped', bytes: 0 }; }
          const prefix = hash.slice(0, 8);
          finalPath = path.join(outputDir, `${filename}_${prefix}.${finalExt}`);
        }

        this.fileService.ensureDir(outputDir);
        fs.writeFileSync(finalPath, buffer);

        if (timestamp) setFileTimestamps(finalPath, timestamp);

        const storedName = path.basename(finalPath);
        this.seenHashes.add(hash);
        this.db.insertHash(hash, storedName, bytes, guildId || null, channelId || null, null);

        logger?.log(`Downloaded ${storedName} (${bytes} bytes)`);
        return { status: 'downloaded', bytes };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.log(`Attempt ${attempt}/${this.retries} failed: ${msg}`);
        if (channelId && isCancelled(channelId)) return { status: 'failed', bytes: 0 };
        if (attempt < this.retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          logger?.log(`Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    logger?.log(`Failed ${filename} after ${this.retries} attempts`);
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
    logger?: SessionLogger,
  ): Promise<{ status: 'downloaded' | 'skipped' | 'failed'; bytes: number }> {
    const result = await this.tryDownload(proxyUrl || url, outputDir, filename, category, ext, guildId, channelId, timestamp, logger);
    if (result.status !== 'failed' || !proxyUrl || url === proxyUrl) return result;
    logger?.log(`Proxy failed, falling back to direct URL`);
    return this.tryDownload(url, outputDir, filename, category, ext, guildId, channelId, timestamp, logger);
  }

  private async downloadEmojis(
    messages: Message[],
    baseDir: string,
    concurrency = 3,
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
          await this.fileService.downloadWithMime(url, null, emojiDir, emojiId);
          return 0;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          downloaded++;
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
    logger?: SessionLogger,
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

    const attResult = await this.downloadEntryList(attachmentEntries, 'attachments', baseDir, message.guild?.id, message.channel.id, undefined, 3, logger);
    const embedResult = await this.downloadEntryList(embedEntries, 'embeds', baseDir, message.guild?.id, message.channel.id, undefined, 3, logger);

    return { count: attResult.count + embedResult.count, bytes: attResult.bytes + embedResult.bytes };
  }
}
