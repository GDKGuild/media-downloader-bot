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

const UPLOAD_TIMEOUT = parseInt(process.env.MEGA_UPLOAD_TIMEOUT || '300000', 10);
const UPLOAD_CONCURRENCY = parseInt(process.env.MEGA_UPLOAD_CONCURRENCY || '3', 10);

export class MegaService {
  private storage: Storage | null = null;
  private rootFolder: string;
  private dirCache: Map<string, any>;
  private email: string = '';
  private password: string = '';
  private maxRetries: number;
  private locks: Map<string, Promise<void>> = new Map();
  private connectCallbacks: (() => void)[] = [];
  private connected = false;

  constructor() {
    this.rootFolder = process.env.MEGA_ROOT || 'MediaDownloader';
    this.maxRetries = parseInt(process.env.MEGA_RETRIES || '3', 10);
    this.dirCache = new Map();
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let resolve: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    this.locks.set(key, promise);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      resolve!();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnect(cb: () => void): void {
    if (this.connected) {
      cb();
    } else {
      this.connectCallbacks.push(cb);
    }
  }

  private fireConnectCallbacks(): void {
    this.connected = true;
    const cbs = this.connectCallbacks.slice();
    this.connectCallbacks = [];
    for (const cb of cbs) {
      try { cb(); } catch (err) { console.error('[MEGA] onConnect callback error:', err); }
    }
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
      this.fireConnectCallbacks();
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
      this.fireConnectCallbacks();
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
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Upload timed out')), UPLOAD_TIMEOUT)
      );
      await Promise.race([result.complete, errPromise, timeoutPromise]);
    }, `upload ${fileName}`);
  }

  async uploadDirectory(localPath: string, remoteFolder: string, deleteAfter = false): Promise<void> {
    if (!this.storage) return;
    if (!fs.existsSync(localPath)) return;

    await this.withLock(`upload:${remoteFolder}`, async () => {
      const remoteBase = await this.mkdirRecursive(this.storage!.root, this.rootFolder);
      const remoteDir = await this.mkdirRecursive(remoteBase, remoteFolder);
      await this.uploadRecursive(localPath, remoteDir, deleteAfter);
      console.log(`[MEGA] Upload complete: ${remoteFolder}`);
    });
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
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Upload timed out')), UPLOAD_TIMEOUT)
      );
      await Promise.race([result.complete, errPromise, timeoutPromise]);
    }, `upload ${fileName}`);
  }

  async uploadDirectoryAndClean(localPath: string, remoteFolder: string): Promise<void> {
    if (!this.storage) return;
    if (!fs.existsSync(localPath)) return;

    await this.uploadDirectory(localPath, remoteFolder, true);
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

  private async uploadRecursive(localDir: string, remoteDir: any, deleteAfter = false): Promise<void> {
    const entries = fs.readdirSync(localDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const localPath = path.join(localDir, entry.name);
        const subDir = await this.mkdirRecursive(remoteDir, entry.name);
        await this.uploadRecursive(localPath, subDir, deleteAfter);
      }
    }

    const files = entries.filter(e => e.isFile());
    for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
      const batch = files.slice(i, i + UPLOAD_CONCURRENCY);
      await Promise.all(batch.map(async (entry) => {
        const localPath = path.join(localDir, entry.name);
        let stat;
        try {
          stat = fs.statSync(localPath);
        } catch (err: any) {
          if (err?.code === 'ENOENT') {
            console.log(`[MEGA] Skipped ${entry.name} (disappeared before upload)`);
            return;
          }
          throw err;
        }
        const existing = remoteDir.children?.find((c: any) => c.name === entry.name && !c.directory && c.size === stat.size);
        if (existing) {
          console.log(`[MEGA] Skipped ${entry.name} (already exists in this dir)`);
          if (deleteAfter) {
            try { fs.unlinkSync(localPath); } catch {}
          }
          return;
        }
        await this.callWithRetry(async () => {
          let stream;
          try {
            stream = fs.createReadStream(localPath);
          } catch (err: any) {
            if (err?.code === 'ENOENT') {
              console.log(`[MEGA] Skipped ${entry.name} (disappeared before upload stream)`);
              return;
            }
            throw err;
          }
          const result = remoteDir.upload({ name: entry.name, size: stat.size }, stream);
          const errPromise = new Promise<never>((_, reject) => result.on('error', reject));
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Upload timed out')), UPLOAD_TIMEOUT)
          );
          await Promise.race([result.complete, errPromise, timeoutPromise]);
        }, `upload ${entry.name}`);
        if (deleteAfter) {
          try { fs.unlinkSync(localPath); } catch {}
        }
      }));
    }
  }

  private async mkdirRecursive(parent: any, folderPath: string): Promise<any> {
    return this.withLock(`${parent.nodeId}/${folderPath}`, async () => {
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
    });
  }
}
