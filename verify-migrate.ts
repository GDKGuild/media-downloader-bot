import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { finalizeQueue, isolateQueue, processingPathFor } from './src/utils/migrationQueue';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-verify-'));

function writeQueue(queuePath: string, relativePaths: string[], trailingNewline = true) {
  const lines = relativePaths.map((relativePath) => JSON.stringify({ relativePath, bytes: 1, timestamp: 1 }));
  fs.writeFileSync(queuePath, lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf-8');
}

function readEntries(queuePath: string): string[] {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { relativePath: string }).relativePath)
    .sort();
}

// --- 1. path derivation ---
check('processing path derived', processingPathFor('/a/.migration-queue.jsonl'), '/a/.migration-queue.processing.jsonl');
check('non-jsonl path untouched', processingPathFor('/a/queue'), '/a/queue');

// --- 2. isolate: renames live queue out of the way ---
const unit = path.join(tmp, 'unit');
fs.mkdirSync(unit, { recursive: true });
const q = path.join(unit, '.migration-queue.jsonl');
const p = path.join(unit, '.migration-queue.processing.jsonl');

writeQueue(q, ['ok.bin', 'bad.bin']);
check('isolate returns processing path', isolateQueue(q), p);
check('isolate moved queue to processing', fs.existsSync(p), true);
check('isolate removed live queue', fs.existsSync(q), false);

// --- 3. isolate: stale processing from a crashed run is merged, not dropped ---
fs.writeFileSync(p, JSON.stringify({ relativePath: 'stale.bin', bytes: 1, timestamp: 1 }), 'utf-8');
writeQueue(q, ['fresh.bin']);
isolateQueue(q);
check('stale processing merged into new isolation', readEntries(p), ['fresh.bin', 'stale.bin']);

// --- 4. isolate: no queue at all ---
const empty = path.join(tmp, 'empty-root', 'q.jsonl');
fs.mkdirSync(path.dirname(empty), { recursive: true });
check('isolate with no queue returns processing path', isolateQueue(empty), processingPathFor(empty));
check('isolate with no queue creates nothing', [fs.existsSync(empty), fs.existsSync(processingPathFor(empty))], [false, false]);

// --- 5. finalize: clean run deletes the processing file ---
writeQueue(q, ['a.bin', 'b.bin']);
finalizeQueue(isolateQueue(q), q, new Set());
check('finalize removes processing on clean run', fs.existsSync(p), false);
check('finalize leaves no live queue on clean run', fs.existsSync(q), false);

// --- 6. finalize: only failed entries are written back ---
writeQueue(q, ['ok.bin', 'bad.bin']);
finalizeQueue(isolateQueue(q), q, new Set(['bad.bin']));
check('finalize keeps only failed entries', readEntries(q), ['bad.bin']);
check('finalize removes processing file', fs.existsSync(p), false);

// --- 7. finalize: null (isolation refused) is a no-op ---
writeQueue(q, ['keep.bin']);
finalizeQueue(null, q, new Set(['keep.bin']));
check('finalize(null) leaves live queue untouched', readEntries(q), ['keep.bin']);

// --- 8. entries appended during the run survive finalize ---
writeQueue(q, ['e1.bin', 'e2.bin']);
const isolated = isolateQueue(q);
fs.appendFileSync(q, JSON.stringify({ relativePath: 'e3.bin', bytes: 1, timestamp: 1 }) + '\n');
finalizeQueue(isolated, q, new Set(['e1.bin']));
check('entries appended during run survive finalize', readEntries(q), ['e1.bin', 'e3.bin']);

// --- 9. end-to-end: real script run with one deliberate failure ---
const dl = path.join(tmp, 'downloads');
const drive = path.join(tmp, 'drive');
fs.mkdirSync(path.join(dl, 'blocked'), { recursive: true });
fs.mkdirSync(drive, { recursive: true });
fs.writeFileSync(path.join(dl, 'ok.txt'), 'hello world');
fs.writeFileSync(path.join(dl, 'blocked', 'deep.bin'), 'payload');
// a FILE where the destination directory belongs: mkdirSync throws, copy never happens
fs.writeFileSync(path.join(drive, 'blocked'), 'not a directory');

const e2eQueue = path.resolve(dl, '..', '.migration-queue.jsonl');
writeQueue(e2eQueue, ['ok.txt', 'blocked/deep.bin']);

const script = path.resolve('dist/migrate-to-drive.js');
if (!fs.existsSync(script)) {
  console.log('FAIL  dist/migrate-to-drive.js missing — run `npm run build` first');
  failures++;
} else {
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(process.execPath, [script, '--delete'], {
      cwd: process.cwd(),
      env: { ...process.env, DOWNLOAD_DIR: dl, EXTERNAL_DRIVE_PATH: drive },
      encoding: 'utf-8',
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    exitCode = e.status ?? 1;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  check('script exits successfully', exitCode, 0);
  check('script reports one failure', /1 failed/.test(output), true);
  check('verified copy moved and removed source', [fs.existsSync(path.join(dl, 'ok.txt')), fs.existsSync(path.join(drive, 'ok.txt'))], [false, true]);
  check('destination payload intact after fsync + size check', fs.readFileSync(path.join(drive, 'ok.txt'), 'utf-8'), 'hello world');
  check('failed source retained', fs.existsSync(path.join(dl, 'blocked', 'deep.bin')), true);
  check('failed entry preserved in queue', readEntries(e2eQueue), ['blocked/deep.bin']);
  check('no processing file left behind', fs.existsSync(processingPathFor(e2eQueue)), false);
}

// --- 10. wiring guards ---
const storageSrc = fs.readFileSync('src/services/storageService.ts', 'utf8');
check('storageService no longer unlinks the queue unconditionally', !/fs\.unlinkSync\(this\.queuePath\)/.test(storageSrc), true);
check('storageService isolates the queue', /isolateQueue\(this\.queuePath\)/.test(storageSrc), true);

const migrateSrc = fs.readFileSync('src/migrate-to-drive.ts', 'utf8');
check('script fsyncs before deleting source', /fsyncSync/.test(migrateSrc), true);
check('script verifies size before deleting source', /verifiedSize !== file\.size/.test(migrateSrc), true);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  console.log(`(note: temp dir ${tmp} still locked, harmless)`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
