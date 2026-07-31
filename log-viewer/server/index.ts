import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', '..', 'activity-logs');

const app = express();
app.use(express.json());

interface LogEntry {
  date: string;
  userId: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  filename: string;
  mode: 'Simple' | 'Advanced';
  filePath: string;
}

function getModeFromContent(content: string): 'Simple' | 'Advanced' {
  if (content.includes('[Advanced]')) return 'Advanced';
  return 'Simple';
}

function parseFilename(filename: string): { userId: string; username: string } | null {
  const match = filename.match(/^(\d+)-(.+)\.log$/);
  if (!match) return null;
  return { userId: match[1], username: match[2] };
}

function parseNames(content: string, fallback: string): { serverName: string; globalName: string } {
  // Format: # [Mode] Activity Log — ServerName (GlobalName)
  const fullMatch = content.match(/^# .+ — (.+) \((.+)\)$/m);
  if (fullMatch) return { serverName: fullMatch[1], globalName: fullMatch[2] };
  // Fallback: # [Mode] Activity Log — SingleName (@username) — old format or single name
  const simpleMatch = content.match(/^# .+ — (.+?)(?: \(@\S+\))?$/m);
  if (simpleMatch) return { serverName: simpleMatch[1], globalName: simpleMatch[1] };
  return { serverName: fallback, globalName: fallback };
}

function parseGuild(content: string): string {
  const match = content.match(/^# Guild: (.+)$/m);
  return match ? match[1] : '';
}

function getAllLogs(): LogEntry[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  const dates = fs.readdirSync(LOG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const logs: LogEntry[] = [];
  for (const date of dates) {
    const dateDir = path.join(LOG_DIR, date);
    const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.log'));
    for (const file of files) {
      const parsed = parseFilename(file);
      if (!parsed) continue;
      const filePath = path.join(dateDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const { serverName, globalName } = parseNames(content, parsed.username);
      logs.push({
        date,
        userId: parsed.userId,
        username: parsed.username,
        serverName,
        globalName,
        guildName: parseGuild(content),
        filename: file,
        mode: getModeFromContent(content),
        filePath,
      });
    }
  }
  return logs;
}

// --- Analytics ---

function getDateRange(dateStr: string, period: 'day' | 'week' | 'month'): string[] {
  const end = new Date(dateStr + 'T00:00:00Z');
  const days: string[] = [];
  const count = period === 'day' ? 1 : period === 'week' ? 7 : 30;
  for (let i = 0; i < count; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

interface ParsedLog {
  totalMessages: number;
  totalMedia: number;
  channels: { name: string; messages: number }[];
}

function parseLogContent(content: string): ParsedLog {
  const result: ParsedLog = { totalMessages: 0, totalMedia: 0, channels: [] };

  const msgMatch = content.match(/^-\s*Total messages:\s*(\d+)/m);
  if (msgMatch) result.totalMessages = parseInt(msgMatch[1], 10);

  const mediaMatch = content.match(/^-\s*Media sent:\s*(\d+)/m);
  if (mediaMatch) result.totalMedia = parseInt(mediaMatch[1], 10);

  const sessionRegex = /### Session \d+ — #(\S+).*?\(.*?(\d+) messages\)/g;
  let m: RegExpExecArray | null;
  while ((m = sessionRegex.exec(content)) !== null) {
    const name = m[1].replace(/_/g, ' ');
    const count = parseInt(m[2], 10);
    result.channels.push({ name, messages: count });
  }

  return result;
}

function buildLatestLogMap(): Map<string, { date: string; filename: string }> {
  const map = new Map<string, { date: string; filename: string }>();
  if (!fs.existsSync(LOG_DIR)) return map;
  const dates = fs.readdirSync(LOG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();
  for (const date of dates) {
    const dateDir = path.join(LOG_DIR, date);
    const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.log'));
    for (const file of files) {
      const parsed = parseFilename(file);
      if (!parsed) continue;
      if (!map.has(parsed.userId)) map.set(parsed.userId, { date, filename: file });
    }
  }
  return map;
}

app.get('/api/analytics', (req, res) => {
  const period = (req.query.period as 'day' | 'week' | 'month') || 'day';
  const date = (req.query.date as string) || '';
  if (!date) {
    res.status(400).json({ error: 'date parameter required' });
    return;
  }

  const dates = getDateRange(date, period);

  if (!fs.existsSync(LOG_DIR)) {
    res.json({ period, dateRange: dates, users: [] });
    return;
  }

  const userMap = new Map<string, {
    userId: string;
    username: string;
    serverName: string;
    globalName: string;
    guildName: string;
    totalMessages: number;
    totalMedia: number;
    channels: Map<string, number>;
    dates: Set<string>;
  }>();

  for (const d of dates) {
    const dateDir = path.join(LOG_DIR, d);
    if (!fs.existsSync(dateDir)) continue;

    const files = fs.readdirSync(dateDir).filter(f => f.endsWith('.log'));
    for (const file of files) {
      const parsed = parseFilename(file);
      if (!parsed) continue;

      const filePath = path.join(dateDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const logData = parseLogContent(content);

      let user = userMap.get(parsed.userId);
      if (!user) {
        const { serverName, globalName } = parseNames(content, parsed.username);
        user = {
          userId: parsed.userId,
          username: parsed.username,
          serverName,
          globalName,
          guildName: parseGuild(content),
          totalMessages: 0,
          totalMedia: 0,
          channels: new Map(),
          dates: new Set(),
        };
        userMap.set(parsed.userId, user);
      }

      user.totalMessages += logData.totalMessages;
      user.totalMedia += logData.totalMedia;
      user.dates.add(d);

      for (const ch of logData.channels) {
        user.channels.set(ch.name, (user.channels.get(ch.name) || 0) + ch.messages);
      }
    }
  }

  const users = Array.from(userMap.values());
  const maxMessages = Math.max(...users.map(u => u.totalMessages), 1);
  const latestLogMap = buildLatestLogMap();

  const ranked = users
    .map(u => {
      const score = Math.round((u.totalMessages / maxMessages) * 100);
      const channels = Array.from(u.channels.entries())
        .map(([name, messages]) => ({ name, messages }))
        .sort((a, b) => b.messages - a.messages);
      return {
        userId: u.userId,
        username: u.username,
        serverName: u.serverName,
        globalName: u.globalName,
        guildName: u.guildName,
        score,
        totalMessages: u.totalMessages,
        totalMedia: u.totalMedia,
        activeDays: u.dates.size,
        channels,
        latestLog: latestLogMap.get(u.userId) || null,
      };
    })
    .sort((a, b) => b.score - a.score);

  res.json({ period, dateRange: dates, users: ranked });
});

app.get('/api/users', (_req, res) => {
  const logs = getAllLogs();
  const users = logs
    .map(l => ({
      date: l.date,
      filename: l.filename,
      userId: l.userId,
      username: l.username,
      serverName: l.serverName,
      globalName: l.globalName,
      guildName: l.guildName,
      mode: l.mode,
      size: fs.statSync(l.filePath).size,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.username.localeCompare(b.username));
  res.json({ users });
});

app.get('/api/dates', (_req, res) => {
  if (!fs.existsSync(LOG_DIR)) {
    res.json({ dates: [] });
    return;
  }
  const dates = fs.readdirSync(LOG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      date: d.name,
      userCount: fs.readdirSync(path.join(LOG_DIR, d.name)).filter(f => f.endsWith('.log')).length,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  res.json({ dates });
});

app.get('/api/logs/:date', (req, res) => {
  const dateDir = path.join(LOG_DIR, req.params.date);
  if (!fs.existsSync(dateDir)) {
    res.status(404).json({ error: 'Date not found' });
    return;
  }
  const files = fs.readdirSync(dateDir)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const filePath = path.join(dateDir, f);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFilename(f);
      const username = parsed?.username || 'unknown';
      const { serverName, globalName } = parseNames(content, username);
      return {
        filename: f,
        userId: parsed?.userId || 'unknown',
        username,
        serverName,
        globalName,
        guildName: parseGuild(content),
        mode: getModeFromContent(content),
        size: fs.statSync(filePath).size,
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username));
  res.json({ date: req.params.date, users: files });
});

app.get('/api/logs/:date/:file', (req, res) => {
  const safeFile = path.basename(req.params.file);
  const filePath = path.join(LOG_DIR, req.params.date, safeFile);
  if (!filePath.startsWith(LOG_DIR) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFilename(safeFile);
  const username = parsed?.username || 'unknown';
  const { serverName, globalName } = parseNames(content, username);
  res.json({
    date: req.params.date,
    filename: safeFile,
    userId: parsed?.userId || 'unknown',
    username,
    serverName,
    globalName,
    guildName: parseGuild(content),
    mode: getModeFromContent(content),
    content,
  });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q as string || '').toLowerCase();
  if (!q) {
    res.json({ results: [] });
    return;
  }
  const allLogs = getAllLogs();
  const results = allLogs
    .map(log => {
      const content = fs.readFileSync(log.filePath, 'utf-8');
      const lower = content.toLowerCase();
      const lines = content.split('\n');
      const matches = lines
        .map((line, i) => ({ line: line.trim(), index: i }))
        .filter(m => m.line.toLowerCase().includes(q));
      return { ...log, matchCount: matches.length, matches };
    })
    .filter(r => r.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, 200);

  res.json({ query: q, results });
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

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`Log API server running on http://localhost:${PORT}`);
});
