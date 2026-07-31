import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface MigrationEntry {
  relativePath: string;
  bytes: number;
  timestamp: number;
}

export class StorageService {
  private primaryPath: string;
  private fallbackPath: string;
  private expectedLabel: string;
  private available: boolean;
  private wasAvailable: boolean;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onDriveAvailable: (() => void) | null = null;
  private queuePath: string;

  constructor(primaryPath: string, fallbackPath: string, expectedLabel = '') {
    this.primaryPath = primaryPath;
    this.fallbackPath = fallbackPath;
    this.expectedLabel = expectedLabel;
    this.available = false;
    this.wasAvailable = false;
    this.queuePath = path.resolve(fallbackPath, '..', '.migration-queue.jsonl');
  }

  isDriveAvailable(): boolean {
    return this.available;
  }

  getActiveRoot(): string {
    return this.available ? this.primaryPath : this.fallbackPath;
  }

  getStorageLabel(): string {
    return this.available ? 'external drive' : 'local fallback';
  }

  getBaseDir(guildName: string, channelName: string, parentChannelName?: string): string {
    const root = this.getActiveRoot();
    const parts = [root, sanitize(guildName)];
    if (parentChannelName) parts.push(sanitize(parentChannelName));
    parts.push(sanitize(channelName));
    return path.join(...parts);
  }

  setOnDriveAvailable(cb: () => void): void {
    this.onDriveAvailable = cb;
  }

  startPolling(intervalMs = 15000): void {
    if (this.pollTimer) return;
    this.checkAndNotify();
    this.pollTimer = setInterval(() => this.checkAndNotify(), intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private checkAndNotify(): void {
    const now = this.checkDrive();
    if (now && !this.wasAvailable) {
      this.onDriveAvailable?.();
    }
    this.wasAvailable = this.available;
  }

  private checkDrive(): boolean {
    if (!fs.existsSync(this.primaryPath)) {
      this.available = false;
      return false;
    }
    if (this.expectedLabel) {
      try {
        const letter = path.parse(this.primaryPath).root.replace(/\\/g, '');
        if (letter.length >= 2 && letter[1] === ':') {
          const label = execSync(
            `powershell -Command "(Get-Volume -DriveLetter ${letter[0]}).FileSystemLabel"`,
            { encoding: 'utf-8', timeout: 5000 }
          ).toString().trim();
          this.available = label === this.expectedLabel;
          return this.available;
        }
      } catch {
        this.available = false;
        return false;
      }
    }
    this.available = true;
    return true;
  }

  enqueueMigration(relativePath: string, bytes: number): void {
    const dir = path.dirname(this.queuePath);
    fs.mkdirSync(dir, { recursive: true });
    const entry: MigrationEntry = { relativePath, bytes, timestamp: Date.now() };
    fs.appendFileSync(this.queuePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  queueCount(): number {
    return this.listQueue().length;
  }

  private listQueue(): MigrationEntry[] {
    if (!fs.existsSync(this.queuePath)) return [];
    return fs.readFileSync(this.queuePath, 'utf-8').split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) as MigrationEntry; } catch { return null; } })
      .filter((e): e is MigrationEntry => e !== null);
  }

  async migrateToPrimary(): Promise<{ moved: number; failed: number }> {
    if (!this.available) return { moved: 0, failed: 0 };

    const entries = this.listQueue();
    if (entries.length === 0) return { moved: 0, failed: 0 };

    let moved = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        const source = path.join(this.fallbackPath, entry.relativePath);
        const dest = path.join(this.primaryPath, entry.relativePath);

        if (!fs.existsSync(source)) {
          failed++;
          continue;
        }

        if (fs.existsSync(dest)) {
          const sourceStat = fs.statSync(source);
          const destStat = fs.statSync(dest);
          if (sourceStat.size === destStat.size) {
            fs.unlinkSync(source);
            moved++;
            continue;
          }
          fs.unlinkSync(dest);
        }

        const destDir = path.dirname(dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(source, dest);
        this.cleanupEmptyDirs(path.dirname(source), this.fallbackPath);
        moved++;
      } catch {
        try {
          const source = path.join(this.fallbackPath, entry.relativePath);
          const dest = path.join(this.primaryPath, entry.relativePath);
          if (fs.existsSync(source)) {
            const destDir = path.dirname(dest);
            fs.mkdirSync(destDir, { recursive: true });
            const buf = fs.readFileSync(source);
            fs.writeFileSync(dest, buf);
            fs.unlinkSync(source);
            this.cleanupEmptyDirs(path.dirname(source), this.fallbackPath);
            moved++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
    }

    try { fs.unlinkSync(this.queuePath); } catch {}
    return { moved, failed };
  }

  private cleanupEmptyDirs(dir: string, stopAt: string): void {
    let current = dir;
    while (current.startsWith(stopAt) && current !== stopAt) {
      try {
        const entries = fs.readdirSync(current);
        if (entries.length === 0) {
          fs.rmdirSync(current);
          current = path.dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
}
