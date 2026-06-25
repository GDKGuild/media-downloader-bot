import * as fs from 'fs';
import * as path from 'path';
import { MediaConfig } from '../types';

export interface DeferredEntry {
  guildId: string;
  channelId: string;
  messageId: string;
  guildName: string;
  channelName: string;
  parentChannelName?: string;
  mediaConfig: MediaConfig;
  timestamp: number;
}

function entryKey(e: DeferredEntry): string {
  return `${e.guildId}|${e.channelId}|${e.messageId}`;
}

export class DeferredDownloadQueue {
  private filePath: string;

  constructor(downloadDir: string) {
    this.filePath = path.resolve(downloadDir, '..', '.deferred-queue.jsonl');
  }

  enqueue(entry: DeferredEntry): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf-8');
  }

  list(): DeferredEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
    const entries: DeferredEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as DeferredEntry;
        if (entry.guildId && entry.channelId && entry.messageId) {
          entries.push(entry);
        }
      } catch {
        // skip corrupted line
      }
    }
    return entries;
  }

  remove(entry: DeferredEntry): void {
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
    const targetKey = entryKey(entry);
    const remaining = lines.filter(line => {
      try {
        const e = JSON.parse(line) as DeferredEntry;
        return entryKey(e) !== targetKey;
      } catch {
        return true;
      }
    });
    if (remaining.length === 0) {
      fs.unlinkSync(this.filePath);
    } else {
      fs.writeFileSync(this.filePath, remaining.join('\n') + '\n', 'utf-8');
    }
  }

  count(): number {
    return this.list().length;
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}
