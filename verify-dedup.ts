import fs from 'fs';
import os from 'os';
import path from 'path';
import D from 'better-sqlite3';
import { DatabaseService } from './src/services/databaseService';
import { cdnUrlPath, isDiscordCdnUrl } from './src/utils/mediaUtils';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

// --- 1. cdnUrlPath: host normalization + signature stripping ---
check('cdnUrlPath strips signature', cdnUrlPath('https://cdn.discordapp.com/attachments/1/2/a.png?ex=abc&is=d'), '/attachments/1/2/a.png');
check('cdnUrlPath normalizes media host to same path',
  cdnUrlPath('https://media.discordapp.net/attachments/1/2/a.png?ex=zzz'),
  cdnUrlPath('https://cdn.discordapp.com/attachments/1/2/a.png?ex=abc'));
check('cdnUrlPath rejects non-CDN host', cdnUrlPath('https://example.com/attachments/1/2/a.png'), null);
check('cdnUrlPath rejects junk', cdnUrlPath('not a url'), null);
check('isDiscordCdnUrl still works', [isDiscordCdnUrl('https://cdn.discordapp.com/x'), isDiscordCdnUrl('https://example.com/x')], [true, false]);

// --- 2. migration against a synthetic table shaped like the real one ---
const tmp = path.join(os.tmpdir(), `dedup-verify-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });

const seed = new D(tmp);
seed.exec(`CREATE TABLE file_hashes (
  hash TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  type TEXT NOT NULL, url TEXT, filename TEXT NOT NULL, file_size INTEGER DEFAULT 0,
  category TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hash, guild_id, channel_id, type))`);
const ins = seed.prepare('INSERT INTO file_hashes (hash, guild_id, channel_id, type, url, filename) VALUES (?,?,?,?,?,?)');
ins.run('h1', 'g1', 'c1', 'media', 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=abc&is=d', 'a.png');
ins.run('h2', 'g1', 'c1', 'media', 'https://media.discordapp.net/attachments/3/4/b.jpg?ex=zzz', 'b.jpg');
ins.run('h3', 'g1', 'c1', 'media', 'https://example.com/scraped.mp4', 'c.mp4');
ins.run('h4', 'g1', 'c1', 'media', null, 'd.png');
// CDN-shaped path on a foreign host: converting this would false-match a real
// Discord CDN path in the same channel and skip the download entirely.
ins.run('h5', 'g1', 'c1', 'media', 'https://mirror.example.com/attachments/7/7/foreign.png', 'e.png');
seed.close();

const svc = new DatabaseService(tmp);
const read = new D(tmp, { readonly: true });
const row = (h: string) => (read.prepare('SELECT url FROM file_hashes WHERE hash = ?').get(h) as any).url;
const fullCdnLeft = (read.prepare(
  "SELECT COUNT(*) n FROM file_hashes WHERE url LIKE 'https://cdn.discordapp.com/%' OR url LIKE 'https://media.discordapp.net/%'"
).get() as any).n;

check('migration converted signed CDN url', row('h1'), '/attachments/1/2/a.png');
check('migration converted proxy-host url', row('h2'), '/attachments/3/4/b.jpg');
check('migration left non-CDN url alone', row('h3'), 'https://example.com/scraped.mp4');
check('migration left NULL alone', row('h4'), null);
check('migration left foreign host with CDN-shaped path alone', row('h5'), 'https://mirror.example.com/attachments/7/7/foreign.png');
check('no full CDN urls remain', fullCdnLeft, 0);

// --- 3. Gate 0 scoping: cross-channel, cross-guild, cross-type must not match ---
svc.insertFileHash('hx', 'g1', 'c1', 'media', '/attachments/9/9/z.png', 'z.png', 10, null);
check('Gate 0 matches same channel', svc.hasFileUrl('/attachments/9/9/z.png', 'g1', 'c1', 'media'), true);
check('Gate 0 does NOT match other channel', svc.hasFileUrl('/attachments/9/9/z.png', 'g1', 'c2', 'media'), false);
check('Gate 0 does NOT match other guild', svc.hasFileUrl('/attachments/9/9/z.png', 'g2', 'c1', 'media'), false);
check('Gate 0 does NOT match other type', svc.hasFileUrl('/attachments/9/9/z.png', 'g1', 'c1', 'emoji'), false);
// --- 4. the false-match scenario this migration guard prevents ---
check('foreign-host row stayed a full url, not a bare pathname', cdnUrlPath(row('h5')), null);
check('foreign-host row cannot trigger Gate 0', svc.hasFileUrl('/attachments/7/7/foreign.png', 'g1', 'c1', 'media'), false);
check('genuine CDN path still triggers Gate 0', svc.hasFileUrl('/attachments/1/2/a.png', 'g1', 'c1', 'media'), true);

// --- 5. re-running init is idempotent ---
new DatabaseService(tmp);
const again = (new D(tmp, { readonly: true }).prepare(
  "SELECT COUNT(*) n FROM file_hashes WHERE url LIKE 'https://cdn.discordapp.com/%'"
).get() as any).n;
check('re-init does not re-migrate or corrupt', again, 0);
check('re-init leaves converted pathname intact', row('h1'), '/attachments/1/2/a.png');

// --- 6. source guards for the sentinel + cap ---
const src = fs.readFileSync('src/services/mediaDownloadService.ts', 'utf8');
check("no empty-string guildId fallback remains", !/guildId \|\| ''/.test(src), true);
check("no empty-string channelId fallback remains", !/channelId \|\| ''/.test(src), true);
check('dead accessors removed', !/getSeenHashes|clearSeenHashes/.test(src), true);
check('seenHashes cap enforced', /this\.seenHashes\.size >= SEEN_HASH_CAP/.test(src), true);
check('Gate 0 is channel-scoped', /hasFileUrl\(cdnPath, gid, cid, type\)/.test(src), true);

read.close();
try {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
} catch {
  console.log(`(note: temp db ${tmp} still locked, harmless)`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);