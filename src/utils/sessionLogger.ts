import * as fs from 'fs';
import * as path from 'path';

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
}

export class SessionLogger {
  private startTime: number;
  private logPath: string;

  constructor(serverName: string, channelName: string, type: 'download' | 'auto') {
    this.startTime = Date.now();
    const ts = type === 'auto'
      ? new Date(this.startTime).toISOString().slice(0, 10)
      : new Date(this.startTime).toISOString().replace(/[:.]/g, '-');
    const logDir = path.join('logs', sanitize(serverName), sanitize(channelName));
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, `${type}-${ts}.log`);
    this.log(`=== Session started ===`);
    this.log(`Server: ${serverName}`);
    this.log(`Channel: #${channelName}`);
    this.log(`Type: ${type}`);
  }

  log(message: string): void {
    const ts = new Date().toISOString();
    fs.appendFileSync(this.logPath, `[${ts}] ${message}\n`, 'utf-8');
  }

  close(summary?: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    this.log(`=== Session ended (${elapsed}s)${summary ? ' - ' + summary : ''} ===`);
  }

  getPath(): string {
    return this.logPath;
  }
}
