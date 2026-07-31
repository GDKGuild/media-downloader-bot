import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pidFile = path.join(__dirname, '.pids.json');

// Point the viewer at the H: drive backup of the downloads folder. Override with
// the MEDIA_DOWNLOAD_DIR env var if the drive letter changes.
const MEDIA_DOWNLOAD_DIR =
  process.env.MEDIA_DOWNLOAD_DIR ||
  'H:\\D\\Jasper\\Projects\\TypeScript\\media-downloader-bot-revised2\\downloads';

if (!fs.existsSync(MEDIA_DOWNLOAD_DIR)) {
  console.error(`Media directory not found: ${MEDIA_DOWNLOAD_DIR}`);
  console.error('Set MEDIA_DOWNLOAD_DIR to the folder containing downloaded media.');
  process.exit(1);
}

const env = { ...process.env, MEDIA_DOWNLOAD_DIR };

const server = spawn('npx tsx server/index.ts', [], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
  env,
});

const vite = spawn('npx vite', [], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
  env,
});

fs.writeFileSync(pidFile, JSON.stringify({ vite: vite.pid }));

const cleanup = () => {
  try { fs.unlinkSync(pidFile); } catch {}
  server.kill();
  vite.kill();
};

server.on('exit', () => {
  vite.kill();
  cleanup();
  setTimeout(() => process.exit(0), 300);
});

vite.on('exit', () => {
  server.kill();
  cleanup();
  setTimeout(() => process.exit(0), 300);
});

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
