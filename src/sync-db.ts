import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { config } from 'dotenv';

config();

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'media_hashes.db');
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  console.log(`Database: ${DB_PATH}`);
  console.log(`Download dir: ${DOWNLOAD_DIR}`);
  console.log('');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const filePaths = walkDir(DOWNLOAD_DIR);
  console.log(`Found ${filePaths.length} files on disk. Computing hashes...`);

  const diskHashes = new Set<string>();
  for (let i = 0; i < filePaths.length; i++) {
    const buf = fs.readFileSync(filePaths[i]);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    diskHashes.add(hash);
    if ((i + 1) % 100 === 0 || i === filePaths.length - 1) {
      console.log(`  Hashed ${i + 1}/${filePaths.length}`);
    }
  }

  const dbRows = db.prepare('SELECT hash, filename, guild_id, channel_id FROM media_hashes').all() as {
    hash: string;
    filename: string;
    guild_id: string | null;
    channel_id: string | null;
  }[];

  let deleted = 0;
  const delStmt = db.prepare('DELETE FROM media_hashes WHERE hash = ?');
  const delBatch = db.transaction((hashes: string[]) => {
    for (const h of hashes) delStmt.run(h);
  });

  const toDelete: string[] = [];
  for (const row of dbRows) {
    if (!diskHashes.has(row.hash)) {
      toDelete.push(row.hash);
      console.log(`  Orphan: ${row.filename} (guild=${row.guild_id}, channel=${row.channel_id})`);
    }
  }

  if (toDelete.length > 0) {
    delBatch(toDelete);
    deleted = toDelete.length;
  }

  console.log('');
  console.log(`DB entries: ${dbRows.length}`);
  console.log(`Deleted:    ${deleted}`);
  console.log(`Remaining:  ${dbRows.length - deleted}`);

  db.close();
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
