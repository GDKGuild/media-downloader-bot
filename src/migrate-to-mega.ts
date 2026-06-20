import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { MegaService } from './services/megaService';

config();

const args = process.argv.slice(2);
const shouldUpload = args.includes('--upload');
const shouldDelete = args.includes('--delete');
const shouldDeleteOnSuccess = args.includes('--delete-on-success');
const shouldForce = args.includes('--force');

const concurrencyIdx = args.indexOf('--concurrency');
const concurrency = concurrencyIdx !== -1
  ? Math.max(1, parseInt(args[concurrencyIdx + 1], 10) || 2)
  : 2;

const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOAD_DIR || './downloads');
const LOGS_DIR = path.resolve('logs');

interface FileEntry {
  localPath: string;
  remotePath: string;
  size: number;
}

type Result = 'uploaded' | 'skipped' | 'failed';

function scanFiles(dir: string, baseDir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  if (!fs.existsSync(dir)) return entries;

  function walk(currentDir: string) {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        const relative = path.relative(baseDir, fullPath);
        entries.push({
          localPath: fullPath,
          remotePath: relative.replace(/\\/g, '/'),
          size: fs.statSync(fullPath).size,
        });
      }
    }
  }

  walk(dir);
  return entries;
}

function cleanupEmptyDirs(dir: string, stopAt: string): void {
  let current = path.dirname(dir);
  while (current.startsWith(stopAt)) {
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

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function logLine(data: Record<string, unknown>): string {
  return JSON.stringify({ _time: timestamp(), ...data }) + '\n';
}

let logStream: fs.WriteStream | null = null;

function openLog(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = `migrate-mega-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  logStream = fs.createWriteStream(path.join(LOGS_DIR, logFile), { flags: 'a' });
}

function writeLog(data: Record<string, unknown>): void {
  if (logStream) logStream.write(logLine(data));
}

function closeLog(summary: Record<string, unknown>): void {
  if (logStream) {
    writeLog({ _event: 'summary', ...summary });
    logStream.end();
    logStream = null;
  }
}

async function main() {
  console.log('MEGA Migration Script');
  console.log('─'.repeat(50));

  const files = scanFiles(DOWNLOADS_DIR, DOWNLOADS_DIR);

  if (files.length === 0) {
    console.log(`No files found in ${DOWNLOADS_DIR}`);
    return;
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`Found ${files.length} files (${formatSize(totalSize)}) in ${DOWNLOADS_DIR}`);

  if (!shouldUpload) {
    console.log('\nDry-run mode (use --upload to actually upload):');
    for (const file of files.slice(0, 20)) {
      console.log(`  ${file.remotePath} (${formatSize(file.size)})`);
    }
    if (files.length > 20) {
      console.log(`  ... and ${files.length - 20} more files`);
    }
    console.log(`\nOptions: --upload, --concurrency N (default 2), --force (skip dup check), --delete, --delete-on-success`);
    return;
  }

  openLog();
  writeLog({ _event: 'start', fileCount: files.length, totalSize, downloadsDir: DOWNLOADS_DIR, concurrency, force: shouldForce });

  console.log('\nConnecting to MEGA...');
  const mega = new MegaService();
  await mega.connect();

  const label = shouldForce ? 'Uploading' : 'Checking';
  console.log(`\n${label} ${files.length} files (concurrency=${concurrency})...`);

  // Pre-create all unique remote directories sequentially (ensures cache is populated)
  const uniqueDirs = new Set(files.map(f => path.dirname(`downloads/${f.remotePath}`).replace(/\\/g, '/')));
  console.log(`  Pre-creating ${uniqueDirs.size} remote directories...`);
  for (const dir of uniqueDirs) {
    await mega.getRemoteDir(dir);
  }
  console.log(`  Done`);

  const processFile = async (file: FileEntry): Promise<Result> => {
    const remotePath = `downloads/${file.remotePath}`;

    if (!shouldForce) {
      const alreadyExists = await mega.fileExists(remotePath, file.size);
      if (alreadyExists) {
        writeLog({ _event: 'skip', file: file.remotePath, size: file.size, reason: 'exists_on_mega' });
        if (shouldDeleteOnSuccess) {
          fs.unlinkSync(file.localPath);
          cleanupEmptyDirs(path.dirname(file.localPath), DOWNLOADS_DIR);
        }
        console.log(`  SKIP ${file.remotePath}`);
        return 'skipped';
      }
    }

    await mega.uploadFile(file.localPath, remotePath);
    writeLog({ _event: 'upload', file: file.remotePath, size: file.size });

    if (shouldDeleteOnSuccess) {
      fs.unlinkSync(file.localPath);
      cleanupEmptyDirs(path.dirname(file.localPath), DOWNLOADS_DIR);
    }

    console.log(`  UPLD ${file.remotePath}`);
    return 'uploaded';
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map((file, idx) =>
        new Promise<Result>(resolve => {
          setTimeout(() => resolve(
            processFile(file).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              writeLog({ _event: 'fail', file: file.remotePath, size: file.size, error: msg });
              console.error(`  Failed: ${file.remotePath} — ${msg}`);
              return 'failed' as Result;
            })
          ), idx * 500);
        })
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'uploaded') uploaded++;
        else if (result.value === 'skipped') skipped++;
        else if (result.value === 'failed') failed++;
      } else {
        failed++;
      }
    }

    const done = Math.min(i + concurrency, files.length);
    console.log(`  [${done}/${files.length}] ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
  }

  console.log(`\nDone: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
  closeLog({ uploaded, skipped, failed, deleteOnSuccess: shouldDeleteOnSuccess, concurrency, force: shouldForce });

  if (shouldDelete && !shouldDeleteOnSuccess && failed === 0) {
    console.log('Deleting all local files...');
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    console.log('Local files deleted');
  } else if (shouldDelete && failed > 0) {
    console.log('Skipping bulk deletion due to upload failures');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  if (logStream) closeLog({ error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
