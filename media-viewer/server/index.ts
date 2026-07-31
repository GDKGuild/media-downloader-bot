import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = path.resolve(process.env.MEDIA_DOWNLOAD_DIR || path.join(__dirname, '..', '..', 'downloads'));

const app = express();
app.use(express.json());

export type MediaType = 'image' | 'video' | 'audio' | 'other';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'tiff']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'wma']);

const CATEGORY_DIRS = new Set(['images', 'videos', 'audio', 'other', 'avatars', 'emojis']);
const STRUCTURAL_DIRS = new Set(['images', 'videos', 'audio', 'other', 'avatars', 'emojis', 'media']);
const META_FILES = new Set(['_meta.json', '_summary.txt', '_summary (1).txt', 'desktop.ini', 'Thumbs.db']);

interface FileEntry {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
  mediaType: MediaType;
  category: string;
}

function getMediaType(filePath: string): MediaType {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'other';
}

function getCategory(relPath: string): string {
  const parts = relPath.split('/');
  const match = parts.find(p => CATEGORY_DIRS.has(p));
  if (match) return match;
  return getMediaType(relPath);
}

function scanTree(dir: string, root: string, skipThreads: boolean): FileEntry[] {
  const files: FileEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  const rel = path.relative(root, dir).split('\\').join('/');
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipThreads && !STRUCTURAL_DIRS.has(entry.name)) continue;
      files.push(...scanTree(full, root, false));
      continue;
    }
    if (!entry.isFile()) continue;
    if (META_FILES.has(entry.name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const fileRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    files.push({
      name: entry.name,
      relPath: fileRel,
      size: stat.size,
      mtime: stat.mtimeMs,
      mediaType: getMediaType(fileRel),
      category: getCategory(fileRel),
    });
  }
  return files;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

app.get('/api/tree', (_req, res) => {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    res.json({ root: DOWNLOAD_DIR, guilds: [] });
    return;
  }

  const guilds = safeReaddir(DOWNLOAD_DIR)
    .filter(d => d.isDirectory())
    .map(d => {
      const guildDir = path.join(DOWNLOAD_DIR, d.name);
      const channels = safeReaddir(guildDir)
        .filter(c => c.isDirectory())
        .map(c => {
          const channelDir = path.join(guildDir, c.name);
          const threads = safeReaddir(channelDir)
            .filter(t => t.isDirectory() && !STRUCTURAL_DIRS.has(t.name))
            .map(t => ({ name: t.name }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
          return { name: c.name, threads };
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { name: d.name, channels };
    })
    .filter(g => g.channels.length > 0);

  res.json({ root: DOWNLOAD_DIR, guilds });
});

app.get('/api/files', (req, res) => {
  const dirParam = (req.query.dir as string || '').trim();
  if (!dirParam) {
    res.status(400).json({ error: 'Missing dir parameter' });
    return;
  }
  const dirPath = path.resolve(DOWNLOAD_DIR, dirParam.split('/').join(path.sep));
  if (!dirPath.startsWith(DOWNLOAD_DIR) || !fs.existsSync(dirPath)) {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }

  const cacheKey = path.relative(DOWNLOAD_DIR, dirPath).split('\\').join('/');
  const isChannelLevel = cacheKey.split('/').length === 2;

  const files = scanTree(dirPath, DOWNLOAD_DIR, isChannelLevel);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  res.json({ dir: cacheKey, files });
});

app.get('/api/media/*', (req, res) => {
  const relPath = (req.params[0] || '').split('/').join(path.sep);
  const filePath = path.resolve(DOWNLOAD_DIR, relPath);
  let isFile = false;
  try {
    isFile = filePath.startsWith(DOWNLOAD_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
  res.sendFile(filePath);
});

app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  try {
    const pidFile = path.resolve(__dirname, '..', '.pids.json');
    if (fs.existsSync(pidFile)) {
      const { vite: vitePid } = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
      if (vitePid) execSync(`taskkill /F /T /PID ${vitePid}`, { stdio: 'ignore' });
    }
  } catch {}
  process.exit(0);
});

const PORT = 3334;
app.listen(PORT, () => {
  console.log(`Media API server running on http://localhost:${PORT}`);
  console.log(`Watching: ${DOWNLOAD_DIR}`);
});
