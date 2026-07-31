import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = 'logs';
const LOG_FILE = 'folder-renames.log';

interface RenameEntry {
  date: string;
  dateLabel: string;
  timeClass: string;
  guildName: string;
  oldChannel: string;
  newChannel: string;
  parentLabel?: string;
}

function getTimeClassification(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 21) return 'Evening';
  return 'Night';
}

function formatDate(date: Date): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export class FolderRenameLogger {
  private logPath: string;
  private pendingRenames: RenameEntry[] = [];

  constructor(downloadDir?: string) {
    const logDir = path.resolve(downloadDir || process.env.DOWNLOAD_DIR || './downloads', '..', LOG_DIR);
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, LOG_FILE);
  }

  logRename(
    guildName: string,
    oldChannelName: string,
    newChannelName: string,
    parentChannelName?: string,
    oldParentChannelName?: string,
  ): void {
    const now = new Date();
    const entry: RenameEntry = {
      date: formatDate(now),
      dateLabel: now.toISOString().slice(0, 10),
      timeClass: getTimeClassification(now.getHours()),
      guildName,
      oldChannel: oldChannelName,
      newChannel: newChannelName,
      parentLabel: parentChannelName
        ? `${oldParentChannelName || parentChannelName} / `
        : undefined,
    };

    this.pendingRenames.push(entry);
    this.appendToLog(entry);
  }

  private appendToLog(entry: RenameEntry): void {
    const lines: string[] = [];
    const existing = fs.existsSync(this.logPath) ? fs.readFileSync(this.logPath, 'utf-8') : '';
    const dateHeader = `=== ${entry.date} ===`;

    if (!existing.includes(dateHeader)) {
      if (existing.trim().length > 0) lines.push('');
      lines.push(dateHeader);
      lines.push('');
    }

    lines.push(`[${entry.timeClass}]`);
    lines.push(`  ${entry.guildName} / ${entry.parentLabel || ''}#${entry.oldChannel} → #${entry.newChannel}`);
    lines.push('');

    fs.appendFileSync(this.logPath, lines.join('\n'), 'utf-8');
  }

  getPopupMessage(): string {
    if (this.pendingRenames.length === 0) return 'No renames detected.';

    const grouped = new Map<string, RenameEntry[]>();
    for (const entry of this.pendingRenames) {
      const key = entry.dateLabel;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(entry);
    }

    const parts: string[] = [];
    for (const [dateKey, entries] of grouped) {
      const date = new Date(dateKey + 'T12:00:00');
      parts.push(`=== ${formatDate(date)} ===`);
      for (const e of entries) {
        parts.push(`  [${e.timeClass}] ${e.guildName} / ${e.parentLabel || ''}#${e.oldChannel} → #${e.newChannel}`);
      }
      parts.push('');
    }

    return parts.join('\n').trim();
  }

  clearPending(): void {
    this.pendingRenames = [];
  }

  getLogPath(): string {
    return this.logPath;
  }
}
