import fs from 'fs';
import os from 'os';
import path from 'path';
import { SnowflakeUtil } from 'discord.js';
import { DownloadWatchdog, isWatchableChannel, lookbackSnowflake } from './src/services/watchdogService';
import { DeferredDownloadQueue, DeferredEntry } from './src/services/deferredDownloadQueue';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeChannel(id: string, kind: 'text' | 'voice' | 'category' | 'forum' | 'dm') {
  return {
    id,
    name: `${kind}-${id}`,
    guild: { id: 'g1', name: 'Guild' },
    parent: null,
    parentId: null,
    isTextBased: () => kind === 'text',
    isVoiceBased: () => kind === 'voice',
    isDMBased: () => kind === 'dm',
  };
}

interface Harness {
  watchdog: DownloadWatchdog;
  fetchCalls: string[];
  downloaded: string[];
  resetCount: () => number;
}

function harness(opts: { messages?: Record<string, string[]>; fail?: string[]; delayMs?: number } = {}): Harness {
  const fetchCalls: string[] = [];
  const downloaded: string[] = [];
  let resets = 0;

  const channels = new Map<string, unknown>();
  for (const id of ['c1', 'c2', 'c3']) {
    channels.set(id, { ...fakeChannel(id, 'text'), isThread: () => false, parent: null });
  }
  channels.set('cat', fakeChannel('cat', 'category'));

  const client = { guilds: { cache: new Map([['g1', { channels: { cache: channels } }]]) } };

  const fetchService = {
    async fetchNewMessages(channelId: string) {
      fetchCalls.push(channelId);
      if (opts.fail?.includes(channelId)) throw new Error('Missing Access');
      if (opts.delayMs) await sleep(opts.delayMs);
      const ids = opts.messages?.[channelId] ?? [];
      return { messages: ids.map((id) => ({ id, content: '', embeds: [] })), mediaCount: ids.length };
    },
  };

  const downloadService = {
    clearScrapeCache() { resets++; },
    async renameIfNeeded() { return '/tmp'; },
    async downloadNewMessageMedia(message: { id: string }) {
      downloaded.push(message.id);
      return 2;
    },
  };

  const watchdog = new DownloadWatchdog(
    client as never,
    fetchService as never,
    downloadService as never,
    { images: true, videos: true, audio: true, other: true },
  );

  return { watchdog, fetchCalls, downloaded, resetCount: () => resets };
}

async function main(): Promise<void> {
  // --- 1. lookback cutoff math ---
  const now = 1760000000000;
  const cutoff = lookbackSnowflake(now, 30 * 60000);
  check('30 min lookback lands 30 min before now',
    Number(SnowflakeUtil.deconstruct(cutoff).timestamp), now - 30 * 60000);
  check('30 min cutoff is older than a 10 min cutoff',
    BigInt(cutoff) < BigInt(lookbackSnowflake(now, 10 * 60000)), true);
  check('cutoff is a decimal id string', /^\d+$/.test(cutoff), true);

  // --- 2. channel selection ---
  check('text channel is watchable', isWatchableChannel(fakeChannel('1', 'text') as never), true);
  check('voice channel is watchable', isWatchableChannel(fakeChannel('2', 'voice') as never), true);
  check('category is not watchable', isWatchableChannel(fakeChannel('3', 'category') as never), false);
  check('forum is not watchable (its threads are)', isWatchableChannel(fakeChannel('4', 'forum') as never), false);
  check('dm is not watchable', isWatchableChannel(fakeChannel('5', 'dm') as never), false);

  // --- 3. sweep behaviour ---
  {
    const h = harness();
    await h.watchdog.sweep();
    check('only text/voice channels are polled', h.fetchCalls.sort(), ['c1', 'c2', 'c3']);
  }
  {
    const h = harness({ messages: { c1: ['m1', 'm2'], c2: ['m3'] } });
    await h.watchdog.sweep();
    check('all fetched messages processed', h.downloaded.sort(), ['m1', 'm2', 'm3']);
  }
  {
    const h = harness();
    await h.watchdog.sweep();
    check('no messages means no downloads', h.downloaded, []);
  }
  {
    const h = harness({ messages: { c2: ['m1'] }, fail: ['c1'] });
    await h.watchdog.sweep();
    check('sweep continues past an unreachable channel', h.downloaded, ['m1']);
    check('unreachable channel does not block other channels', h.fetchCalls, ['c1', 'c2', 'c3']);
  }
  {
    const h = harness({ delayMs: 30 });
    await Promise.all([h.watchdog.sweep(), h.watchdog.sweep()]);
    check('a tick already running is skipped', h.fetchCalls, ['c1', 'c2', 'c3']);
  }
  {
    const h = harness();
    await h.watchdog.sweep();
    await h.watchdog.sweep();
    check('scrape cache cleared once per tick', h.resetCount(), 2);
  }
  {
    process.env.WATCHDOG_INTERVAL_SECONDS = '0';
    const h = harness();
    h.watchdog.start();
    h.watchdog.stop();
    check('interval 0 disables the timer', h.fetchCalls, []);
    process.env.WATCHDOG_INTERVAL_SECONDS = '120';
  }

  // --- 4. deferred queue stays idempotent under repeated sweeps ---
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-verify-'));
    const queue = new DeferredDownloadQueue(path.join(tmp, 'downloads'));
    const entry: DeferredEntry = {
      guildId: 'g1', channelId: 'c1', messageId: 'm1',
      guildName: 'Guild', channelName: 'general',
      mediaConfig: { images: true, videos: true, audio: true, other: true },
      timestamp: 1,
    };
    queue.enqueue(entry);
    queue.enqueue(entry);
    queue.enqueue({ ...entry, messageId: 'm2' });
    check('re-enqueuing the same message is a no-op', queue.count(), 2);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- 5. wiring guards ---
  const botSrc = fs.readFileSync('src/bot.ts', 'utf8');
  check('bot starts the watchdog on ready', /watchdog\?\.start\(\)/.test(botSrc), true);
  check('bot stops the watchdog on dispose', /watchdog\?\.stop\(\)/.test(botSrc), true);
  check('watchdog respects AUTO_DOWNLOAD',
    /AUTO_DOWNLOAD !== 'false'[\s\S]{0,120}watchdog\?\.start\(\)/.test(botSrc), true);

  const envSrc = fs.readFileSync('.env.example', 'utf8');
  check('env template documents the interval', /^WATCHDOG_INTERVAL_SECONDS=/m.test(envSrc), true);
  check('env template documents the lookback', /^WATCHDOG_LOOKBACK_MINUTES=/m.test(envSrc), true);

  const fetchSrc = fs.readFileSync('src/services/discordService.ts', 'utf8');
  check('after-cursor advances to the newest message',
    /lastId = messageArray\[messageArray\.length - 1\]\.id;/.test(fetchSrc), true);
  check('old 1-message-per-page cursor is gone', /lastId = messageArray\[0\]\.id;/.test(fetchSrc), false);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
