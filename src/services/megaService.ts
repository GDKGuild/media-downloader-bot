import { Storage } from 'megajs';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('eagain') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('econnaborted') ||
      msg.includes('enetunreach') ||
      msg.includes('fetch failed') ||
      msg.includes('temporary congestion') ||
      msg.includes('server malfunction')
    ) return true;
    const cause = (err as any).cause;
    if (cause instanceof Error) {
      const cm = cause.message.toLowerCase();
      if (
        cm.includes('eagain') ||
        cm.includes('econnreset') ||
        cm.includes('econnrefused') ||
        cm.includes('econnaborted') ||
        cm.includes('read eof')
      ) return true;
    }
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class MegaService {
  private storage: Storage | null = null;
  private rootFolder: string;
  private dirCache: Map<string, any>;
  private email: string = '';
  private password: string = '';
  private maxRetries: number;

  constructor() {
    this.rootFolder = process.env.MEGA_ROOT || 'MediaDownloader';
    this.maxRetries = parseInt(process.env.MEGA_RETRIES || '3', 10);
    this.dirCache = new Map();
  }

  isConnected(): boolean {
    return this.storage !== null;
  }

  async connect(): Promise<void> {
    const email = process.env.MEGA_EMAIL;
    const password = process.env.MEGA_PASSWORD;
    if (!email || !password) {
      console.warn('[MEGA] MEGA_EMAIL/MEGA_PASSWORD not set — uploads disabled');
      return;
    }
    this.email = email;
    this.password = password;
    try {
      this.storage = await new Storage({ email, password, keepalive: false }).ready;
      console.log('[MEGA] Connected');
    } catch (err) {
      console.error('[MEGA] Connection failed:', err);
    }
  }

  async reconnect(): Promise<void> {
    console.log('[MEGA] Reconnecting...');
    this.dirCache.clear();
    this.storage = null;
    try {
      this.storage = await new Storage({ email: this.email, password: this.password, keepalive: false }).ready;
      console.log('[MEGA] Reconnected');
    } catch (err) {
      console.error('[MEGA] Reconnect failed:', err);
    }
  }

  async callWithRetry<T>(fn: () => Promise<T>, description: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (isTransientError(err) && attempt < this.maxRetries) {
          const backoff = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          console.log(`[MEGA] ${description} failed (attempt ${attempt}/${this.maxRetries}), retrying in ${backoff}ms: ${err instanceof Error ? err.message : err}`);
          await delay(backoff);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async uploadBuffer(buffer: Buffer, remoteFilePath: string): Promise<void> {
    if (!this.storage) return;
    const remoteDir = path.dirname(remoteFilePath).replace(/\\/g, '/');
    const fileName = path.basename(remoteFilePath);
    const remoteFolder = await this.getRemoteDir(remoteDir);

    await this.callWithRetry(async () => {
      const readable = new Readable();
      readable.push(buffer);
      readable.push(null);
      const result = remoteFolder.upload({ name: fileName, size: buffer.length }, readable);
      const errPromise = new Promise<never>((_, reject) => result.on('error', reject));
      await Promise.race([result.complete, errPromise]);
    }, `upload ${fileName}`);
  }

  async uploadDirectory(localPath: string, remoteFolder: string, deleteAfter = false): Promise<void> {
    if (!this.storage) return;
    if (!fs.existsSync(localPath)) return;

    try {
      const remoteBase = await this.mkdirRecursive(this.storage.root, this.rootFolder);
      const remoteDir = await this.mkdirRecursive(remoteBase, remoteFolder);
      await this.uploadRecursive(localPath, remoteDir);
      console.log(`[MEGA] Upload complete: ${remoteFolder}`);

      if (deleteAfter) {
        fs.rmSync(localPath, { recursive: true, force: true });
        console.log(`[MEGA] Deleted local: ${localPath}`);
      }
    } catch (err) {
      console.error(`[MEGA] Upload failed for ${remoteFolder}:`, err);
    }
  }

  async getRemoteDir(remoteDir: string, forceReload = false): Promise<any> {
    if (!this.storage) throw new Error('Not connected');
    const fullPath = `${this.rootFolder}/${remoteDir}`;
    if (!forceReload) {
      const cached = this.dirCache.get(fullPath);
      if (cached) return cached;
    }

    const folder = await this.callWithRetry(async () => {
      const remoteBase = await this.mkdirRecursive(this.storage!.root, this.rootFolder);
      return await this.mkdirRecursive(remoteBase, remoteDir);
    }, `getRemoteDir ${remoteDir}`);

    // Refresh children so fileExists checks see current state
    if (forceReload && folder.children && typeof folder.loadAttributes === 'function') {
      try { await folder.loadAttributes(); } catch {}
    }

    this.dirCache.set(fullPath, folder);
    return folder;
  }

  async uploadFile(localPath: string, remoteFilePath: string): Promise<void> {
    if (!this.storage) return;
    const stat = fs.statSync(localPath);
    const remoteDir = path.dirname(remoteFilePath).replace(/\\/g, '/');
    const fileName = path.basename(remoteFilePath);
    const remoteFolder = await this.getRemoteDir(remoteDir);

    await this.callWithRetry(async () => {
      const stream = fs.createReadStream(localPath);
      const result = remoteFolder!.upload({ name: fileName, size: stat.size }, stream);
      const errPromise = new Promise<never>((_, reject) => result.on('error', reject));
      await Promise.race([result.complete, errPromise]);
    }, `upload ${fileName}`);
  }

  async fileExists(remoteFilePath: string, localSize: number): Promise<boolean> {
    if (!this.storage) return false;
    try {
      const remoteDir = path.dirname(remoteFilePath).replace(/\\/g, '/');
      const fileName = path.basename(remoteFilePath);
      const remoteFolder = await this.getRemoteDir(remoteDir, true);
      const existing = remoteFolder.children?.find((c: any) => c.name === fileName && !c.directory);
      return existing !== undefined && existing.size === localSize;
    } catch {
      return false;
    }
  }

  async listRemoteFiles(remoteFolder: string): Promise<string[]> {
    if (!this.storage) return [];
    try {
      const remoteBase = await this.mkdirRecursive(this.storage.root, this.rootFolder);
      const parts = remoteFolder.split(/[/\\]+/).filter(Boolean);
      let current: any = remoteBase;
      for (const part of parts) {
        const existing = current.children?.find((c: any) => c.name === part && c.directory);
        if (!existing) return [];
        current = existing;
      }
      return current.children?.filter((c: any) => !c.directory).map((c: any) => c.name) || [];
    } catch {
      return [];
    }
  }

  private async uploadRecursive(localDir: string, remoteDir: any): Promise<void> {
    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      if (entry.isDirectory()) {
        const subDir = await this.mkdirRecursive(remoteDir, entry.name);
        await this.uploadRecursive(localPath, subDir);
      } else if (entry.isFile()) {
        const stat = fs.statSync(localPath);
        const existing = remoteDir.children?.find((c: any) => c.name === entry.name && !c.directory && c.size === stat.size);
        if (existing) {
          console.log(`[MEGA] Skipped ${entry.name} (already exists in this dir)`);
          continue;
        }
        await this.callWithRetry(async () => {
          const stream = fs.createReadStream(localPath);
          const result = remoteDir.upload({ name: entry.name, size: stat.size }, stream);
          const errPromise = new Promise<never>((_, reject) => result.on('error', reject));
          await Promise.race([result.complete, errPromise]);
        }, `upload ${entry.name}`);
      }
    }
  }

  private async mkdirRecursive(parent: any, folderPath: string): Promise<any> {
    const parts = folderPath.split(/[/\\]+/).filter(Boolean);
    let current = parent;
    for (const part of parts) {
      const existing = current.children?.find((c: any) => c.name === part && c.directory);
      if (existing) {
        current = existing;
      } else {
        const created = await current.mkdir({ name: part });
        if (current.children) current.children.push(created);
        current = created;
      }
    }
    return current;
  }
}
