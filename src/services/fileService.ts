import * as fs from 'fs';
import * as path from 'path';
import filenamify from 'filenamify';

const META_FILE = '_meta.json';

export interface ChannelMeta {
  channelId: string;
  guildId: string;
  parentChannelId: string | null;
}

export class FileService {
  private downloadDir: string;
  private maxRetries: number;

  constructor(downloadDir: string, maxRetries = 3) {
    this.downloadDir = downloadDir;
    this.maxRetries = maxRetries;
  }

  ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  getBaseDir(guildName: string, channelName: string, parentChannelName?: string): string {
    const parts = [this.downloadDir, sanitize(guildName)];
    if (parentChannelName) parts.push(sanitize(parentChannelName));
    parts.push(sanitize(channelName));
    const base = path.join(...parts);
    this.ensureDir(base);
    return base;
  }

  getMediaDir(baseDir: string, category: string): string {
    const dir = path.join(baseDir, 'media', category);
    this.ensureDir(dir);
    return dir;
  }

  getAvatarDir(baseDir: string): string {
    const dir = path.join(baseDir, 'avatars');
    this.ensureDir(dir);
    return dir;
  }

  getEmojiDir(baseDir: string): string {
    const dir = path.join(baseDir, 'emojis');
    this.ensureDir(dir);
    return dir;
  }

  buildFilename(originalName: string, timestampMs?: number): string {
    const base = originalName.replace(/\.[^.]+$/, '');
    const ts = timestampMs !== undefined ? `${timestampMs}_` : '';
    const sanitized = sanitize(base);
    const truncated = sanitized.length > 200 ? sanitized.slice(0, 200) : sanitized;
    const name = `${ts}${truncated}`;
    return filenamify(name, { replacement: '_' });
  }

  writeSummary(baseDir: string, content: string): void {
    fs.writeFileSync(path.join(baseDir, '_summary.txt'), content, 'utf-8');
  }

  getDownloadStats(baseDir: string): { totalSize: number; fileCount: number } {
    let totalSize = 0;
    let fileCount = 0;

    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          totalSize += fs.statSync(fullPath).size;
          fileCount++;
        }
      }
    }

    walk(baseDir);
    return { totalSize, fileCount };
  }

  writeMeta(baseDir: string, channelId: string, guildId: string, parentChannelId: string | null): void {
    const meta: ChannelMeta = { channelId, guildId, parentChannelId };
    fs.writeFileSync(path.join(baseDir, META_FILE), JSON.stringify(meta, null, 2), 'utf-8');
  }

  readMeta(baseDir: string): ChannelMeta | null {
    const metaPath = path.join(baseDir, META_FILE);
    if (!fs.existsSync(metaPath)) return null;
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as ChannelMeta;
      if (parsed.channelId) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  findFolderByChannelId(guildDir: string, channelId: string): string | null {
    if (!fs.existsSync(guildDir)) return null;
    const entries = fs.readdirSync(guildDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(guildDir, entry.name);
      const meta = this.readMeta(folderPath);
      if (meta && meta.channelId === channelId) return folderPath;

      // Scan one level deeper for threads
      if (fs.existsSync(folderPath)) {
        const subEntries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const subPath = path.join(folderPath, sub.name);
          const subMeta = this.readMeta(subPath);
          if (subMeta && subMeta.channelId === channelId) return subPath;
        }
      }
    }
    return null;
  }
}

export function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
}
