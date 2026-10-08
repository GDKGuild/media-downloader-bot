import * as fs from 'fs';

export function processingPathFor(queuePath: string): string {
  return queuePath.replace(/\.jsonl$/, '.processing.jsonl');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isolateQueue(queuePath: string): string | null {
  const processingPath = processingPathFor(queuePath);

  if (fs.existsSync(processingPath)) {
    let stale = fs.readFileSync(processingPath, 'utf-8');
    if (stale && !stale.endsWith('\n')) stale += '\n';
    if (stale) fs.appendFileSync(queuePath, stale);
    fs.unlinkSync(processingPath);
  }

  if (!fs.existsSync(queuePath)) return processingPath;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.renameSync(queuePath, processingPath);
      return processingPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' && attempt === 0) {
        sleepSync(200);
        continue;
      }
      console.warn(`[MigrationQueue] Could not isolate queue (${code}); leaving it untouched.`);
      return null;
    }
  }
  return null;
}

export function finalizeQueue(
  processingPath: string | null,
  queuePath: string,
  failedPaths: Set<string>
): void {
  if (!processingPath || !fs.existsSync(processingPath)) return;

  if (failedPaths.size > 0) {
    const keep = fs.readFileSync(processingPath, 'utf-8')
      .split('\n')
      .filter((line) => {
        if (!line) return false;
        try {
          const entry = JSON.parse(line) as { relativePath?: string };
          return !!entry?.relativePath && failedPaths.has(entry.relativePath);
        } catch {
          return false;
        }
      });
    if (keep.length > 0) fs.appendFileSync(queuePath, keep.join('\n') + '\n');
  }

  fs.unlinkSync(processingPath);
}
