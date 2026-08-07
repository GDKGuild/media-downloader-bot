import { config } from 'dotenv';
import { Client, Events } from 'discord.js';
import { createBot, disposeBot, getActivityTracker } from './bot';

config();

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN must be set in .env');
  console.error('Copy .env.example to .env and fill in your values');
  process.exit(1);
}

const BASE_RETRY_MS = parseInt(process.env.BOT_RETRY_BASE_MS || '5000', 10);
const MAX_RETRY_MS = parseInt(process.env.BOT_RETRY_MAX_MS || '300000', 10);
const LOGIN_TIMEOUT_MS = parseInt(process.env.BOT_LOGIN_TIMEOUT_MS || '45000', 10);

let client: Client | null = null;
let connecting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function isConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /handshake|websocket|econnreset|econnrefused|econnaborted|enetunreach|etimedout|timeout|tls|socket|network/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClient(): Client {
  disposeBot();
  if (client) {
    try {
      void client.destroy();
    } catch {
      // ignore
    }
  }
  client = createBot();
  client.on(Events.ShardError, (error) => {
    console.error(`[Connection] Shard error: ${error instanceof Error ? error.message : String(error)}`);
  });
  client.on(Events.Error, (error) => {
    console.error(`[Connection] Client error: ${error instanceof Error ? error.message : String(error)}`);
  });
  return client;
}

async function loginWithTimeout(): Promise<boolean> {
  if (!client) return false;
  const loginPromise = client.login(token);
  const result = await Promise.race([
    loginPromise.then(() => 'ok' as const),
    sleep(LOGIN_TIMEOUT_MS).then(() => 'timeout' as const),
  ]);
  if (result === 'timeout') {
    loginPromise.catch(() => {});
    return false;
  }
  return true;
}

async function connectWithRetry() {
  if (connecting || shuttingDown) return;
  connecting = true;
  let attempt = 0;
  let delay = BASE_RETRY_MS;
  try {
    while (!shuttingDown) {
      attempt++;
      buildClient();
      const ok = await loginWithTimeout();
      if (ok) {
        console.log(`[Connection] Logged in as ${client?.user?.tag ?? 'unknown user'} (attempt ${attempt})`);
        return;
      }
      if (client) {
        try {
          await client.destroy();
        } catch {
          // ignore
        }
      }
      console.log(`[Connection] Connection attempt ${attempt} failed. Retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  if (shuttingDown || connecting || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWithRetry();
  }, BASE_RETRY_MS);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const tracker = getActivityTracker();
  tracker.flushAll();
  tracker.stopFlushInterval();
  disposeBot();
  if (client) {
    try {
      client.destroy();
    } catch {
      // ignore
    }
  }
}

process.on('uncaughtException', (error) => {
  if (isConnectionError(error)) {
    console.error(`[Connection] Uncaught connection error, reconnecting: ${error instanceof Error ? error.message : String(error)}`);
    scheduleReconnect();
    return;
  }
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isConnectionError(reason)) {
    console.error(`[Connection] Unhandled connection rejection, reconnecting: ${reason instanceof Error ? reason.message : String(reason)}`);
    scheduleReconnect();
    return;
  }
  console.error('Unhandled rejection:', reason);
});

void connectWithRetry();

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
