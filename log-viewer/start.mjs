import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pidFile = path.join(__dirname, '.pids.json');

const server = spawn('npx tsx server/index.ts', [], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
});

const vite = spawn('npx vite', [], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: true,
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
