import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { promisify } from 'util';
import axios, { AxiosResponse } from 'axios';
import filenamify from 'filenamify';
import { getExtensionFromMime } from '../utils/mediaUtils';

const pipeline = promisify(stream.pipeline);

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

  async downloadFile(url: string, outputPath: string): Promise<string | null> {
    this.ensureDir(path.dirname(outputPath));

    let lastErr: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response: AxiosResponse<stream.Readable> = await axios({
          method: 'GET',
          url,
          responseType: 'stream',
          timeout: 30000,
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://discord.com/',
          },
        });

        const writer = fs.createWriteStream(outputPath);
        await pipeline(response.data, writer);
        const ct = response.headers['content-type'];
        return typeof ct === 'string' ? ct : null;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.log(`  Retry ${attempt}/${this.maxRetries} for ${url} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastErr;
  }

  async downloadFileWithFallback(
    url: string,
    proxyUrl: string | null,
    outputPath: string
  ): Promise<string | null> {
    try {
      return await this.downloadFile(proxyUrl || url, outputPath);
    } catch {
      if (proxyUrl && url !== proxyUrl) {
        try {
          return await this.downloadFile(url, outputPath);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async downloadWithMime(
    url: string,
    proxyUrl: string | null,
    outputDir: string,
    filename: string
  ): Promise<boolean> {
    const tempPath = path.join(outputDir, `${filename}.tmp`);
    const mime = await this.downloadFileWithFallback(url, proxyUrl, tempPath);

    if (!mime) return false;

    const mimeExt = getExtensionFromMime(mime) || 'dat';
    const finalPath = path.join(outputDir, `${filename}.${mimeExt}`);
    if (fs.existsSync(finalPath)) fs.unlinkSync(tempPath);
    else fs.renameSync(tempPath, finalPath);
    return true;
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
    const name = `${ts}${sanitize(base)}`;
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
}

export function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
}
