import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { finalizeQueue, isolateQueue } from './utils/migrationQueue';

config();

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const shouldDelete = args.includes('--delete');

const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOAD_DIR || './downloads');
const DRIVE_PATH = process.env.EXTERNAL_DRIVE_PATH || '';

interface FileEntry {
  localPath: string;
  relativePath: string;
  size: number;
}

function scanFiles(dir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  if (!fs.existsSync(dir)) return entries;

  function walk(currentDir: string) {
    for (const item of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        const relative = path.relative(DOWNLOADS_DIR, fullPath);
        entries.push({
          localPath: fullPath,
          relativePath: relative.replace(/\\/g, '/'),
          size: fs.statSync(fullPath).size,
        });
      }
    }
  }

  walk(dir);
  return entries;
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

async function main() {
  console.log('External Drive Migration Script');
  console.log('─'.repeat(50));
  console.log('Note: stop the bot first — it shares the migration queue with this script.');

  if (!DRIVE_PATH) {
    console.error('EXTERNAL_DRIVE_PATH not set in .env');
    process.exit(1);
  }

  const driveRoot = path.resolve(DRIVE_PATH);
  console.log(`Source: ${DOWNLOADS_DIR}`);
  console.log(`Dest:   ${driveRoot}`);

  if (!fs.existsSync(driveRoot)) {
    console.error(`\nDestination does not exist: ${driveRoot}`);
    console.error('Connect the drive or create the directory.');
    process.exit(1);
  }

  const queuePath = path.resolve(DOWNLOADS_DIR, '..', '.migration-queue.jsonl');
  const processingPath = isDryRun ? null : isolateQueue(queuePath);

  const files = scanFiles(DOWNLOADS_DIR);
  if (files.length === 0) {
    console.log(`\nNo files found in ${DOWNLOADS_DIR}`);
    finalizeQueue(processingPath, queuePath, new Set());
    process.exit(0);
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`\nFound ${files.length} files (${formatSize(totalSize)})`);

  if (isDryRun) {
    console.log('\nDry-run mode — nothing will be copied:');
    for (const file of files.slice(0, 20)) {
      const destPath = path.join(driveRoot, file.relativePath);
      console.log(`  ${file.relativePath}`);
      console.log(`    → ${destPath} (${formatSize(file.size)})`);
    }
    if (files.length > 20) {
      console.log(`  ... and ${files.length - 20} more files`);
    }
    console.log(`\nRun without --dry-run to copy files; add --delete to remove originals after a verified copy.`);
    return;
  }

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const failedPaths = new Set<string>();

  for (const file of files) {
    const destPath = path.join(driveRoot, file.relativePath);
    const destDir = path.dirname(destPath);

    try {
      if (fs.existsSync(destPath)) {
        const destStat = fs.statSync(destPath);
        if (destStat.size === file.size) {
          if (shouldDelete) {
            fs.unlinkSync(file.localPath);
          }
          skipped++;
          continue;
        }
        fs.unlinkSync(destPath);
      }

      fs.mkdirSync(destDir, { recursive: true });

      fs.copyFileSync(file.localPath, destPath);

      const destFd = fs.openSync(destPath, 'r+');
      try { fs.fsyncSync(destFd); } finally { fs.closeSync(destFd); }

      const verifiedSize = fs.statSync(destPath).size;
      if (verifiedSize !== file.size) {
        throw new Error(`size mismatch after copy: expected ${file.size}, got ${verifiedSize}`);
      }

      if (shouldDelete) {
        fs.unlinkSync(file.localPath);
      }

      copied++;
      process.stdout.write(`\r  [${copied + skipped + failed}/${files.length}] ${copied} copied, ${skipped} skipped, ${failed} failed`);
    } catch (err) {
      // Clean up partial copy on failure
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      failed++;
      failedPaths.add(file.relativePath);
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n  FAIL: ${file.relativePath} — ${msg}`);
    }
  }

  console.log(`\n\nDone: ${copied} copied, ${skipped} skipped, ${failed} failed`);

  if (processingPath && fs.existsSync(processingPath)) {
    finalizeQueue(processingPath, queuePath, failedPaths);
    console.log(failedPaths.size === 0
      ? 'Migration queue cleared.'
      : `Migration queue kept ${failedPaths.size} failed entr${failedPaths.size === 1 ? 'y' : 'ies'} for retry.`);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
