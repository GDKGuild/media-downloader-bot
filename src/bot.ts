import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { FileService } from './services/fileService';
import { DiscordFetchService } from './services/discordService';
import { MediaDownloadService } from './services/mediaDownloadService';
import { DatabaseService } from './services/databaseService';
import { MegaService } from './services/megaService';
import { DeferredDownloadQueue } from './services/deferredDownloadQueue';
import { StorageService } from './services/storageService';
import { TweetMonitorService } from './services/tweetMonitorService';
import { MediaConfig, DownloadProgress } from './types';
import { execute as downloadCommandExecute } from './commands/download';
import { execute as cancelCommandExecute } from './commands/cancel';
import { execute as monitorCommandExecute } from './commands/monitor';
import { handleVerifySelect, MONITOR_VERIFY_SELECT_ID } from './commands/monitor';
import { handleMessageCreate } from './events/messageCreate';
import { ActivityTracker } from './services/activityTracker';
import { ActivityConfig } from './types/activity';

const defaultMediaConfig: MediaConfig = {
  images: true,
  videos: true,
  audio: true,
  other: true,
};

let activityTracker: ActivityTracker;
let currentStorageService: StorageService | undefined;
let tweetMonitor: TweetMonitorService | undefined;

export function getActivityTracker(): ActivityTracker {
  return activityTracker;
}

export function getTweetMonitorService(): TweetMonitorService | undefined {
  return tweetMonitor;
}

export function disposeBot(): void {
  currentStorageService?.stopPolling();
  currentStorageService = undefined;
  tweetMonitor?.stop();
  tweetMonitor = undefined;
}

function logInteractionError(commandName: string, error: unknown): void {
  const err = error as { code?: number } | undefined;
  if (err && typeof err === 'object' && err.code === 10062) {
    console.log(`[Commands] /${commandName}: interaction expired or already handled (10062) — ignored`);
    return;
  }
  console.error(`[Commands] /${commandName}:`, error);
}

export function createBot(): Client {
  const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
  const DOWNLOAD_RETRIES = parseInt(process.env.DOWNLOAD_RETRIES || '3', 10);
  const EXTERNAL_DRIVE_PATH = process.env.EXTERNAL_DRIVE_PATH || '';
  const EXTERNAL_DRIVE_LABEL = process.env.EXTERNAL_DRIVE_LABEL || '';
  const USE_EXTERNAL_DRIVE = !!EXTERNAL_DRIVE_PATH;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
    ],
  });

  const fileService = new FileService(DOWNLOAD_DIR, DOWNLOAD_RETRIES);
  const db = new DatabaseService();

  const storageService = USE_EXTERNAL_DRIVE
    ? new StorageService(EXTERNAL_DRIVE_PATH, DOWNLOAD_DIR, EXTERNAL_DRIVE_LABEL)
    : undefined;
  currentStorageService = storageService;

  let megaService: MegaService | undefined;
  let deferredQueue: DeferredDownloadQueue | undefined;

  if (!USE_EXTERNAL_DRIVE) {
    megaService = new MegaService();
    deferredQueue = new DeferredDownloadQueue(DOWNLOAD_DIR);
  }

  const ts = () => new Date().toISOString().slice(11, 19);

  const fetchService = new DiscordFetchService(client, (progress) => {
    if (progress.total > 0) {
      console.log(`[${ts()}] [${progress.stage}] ${progress.message}`);
    }
  });

  const downloadService = new MediaDownloadService(fileService, db, (progress) => {
    if (progress.total > 0) {
      console.log(`[${ts()}] [${progress.stage}] ${progress.message}`);
    }
  }, DOWNLOAD_DIR, DOWNLOAD_RETRIES, megaService, deferredQueue, storageService);

  tweetMonitor = new TweetMonitorService(client, db, downloadService);

  const activityConfig: ActivityConfig = {
    advancedMode: process.env.ADVANCED_TRACKING === 'true',
    sessionIdleMs: parseInt(process.env.SESSION_IDLE_MINUTES || '5', 10) * 60_000,
  };
  activityTracker = new ActivityTracker(activityConfig);

  if (megaService) {
    megaService.onConnect(() => {
      downloadService.processDeferredQueue(client).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Queue] processDeferredQueue error:', msg);
      });
    });
    megaService.connect().catch(() => {});

    setTimeout(() => {
      if (!megaService.isConnected() && deferredQueue!.count() > 0) {
        console.log(`[Queue] MEGA not connected after 60s, flushing ${deferredQueue!.count()} deferred item(s) without upload`);
        downloadService.processDeferredQueue(client).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Queue] fallback flush error:', msg);
        });
      }
    }, 60000);
  }

  if (storageService) {
    storageService.setOnDriveAvailable(async () => {
      console.log('[Storage] External drive connected — running migration...');
      const { moved, failed } = await storageService.migrateToPrimary();
      if (moved > 0 || failed > 0) {
        console.log(`[Storage] Migration: ${moved} moved, ${failed} failed`);
      }
    });
    storageService.startPolling();
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    if (storageService) {
      console.log(`[Storage] External drive: ${storageService.getStorageLabel()}`);
    }
    console.log(`[Activity] Tracking mode: ${activityConfig.advancedMode ? 'Advanced' : 'Simple'}`);
    activityTracker.startFlushInterval();
    if (process.env.MONITOR_ENABLED !== 'false') {
      tweetMonitor?.start();
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isStringSelectMenu() && interaction.customId === MONITOR_VERIFY_SELECT_ID) {
      try {
        await handleVerifySelect(interaction, db, tweetMonitor);
      } catch (error) {
        logInteractionError('monitor verify select', error);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const ownerIds = (process.env.BOT_OWNER_ID ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    if (ownerIds.length > 0 && !ownerIds.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Only the bot owner can use this command.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === 'download') {
      try {
        await downloadCommandExecute(
          interaction,
          fetchService,
          downloadService,
          fileService,
          db
        );
      } catch (error) {
        logInteractionError('download', error);
      }
    } else if (interaction.commandName === 'cancel') {
      try {
        await cancelCommandExecute(interaction);
      } catch (error) {
        logInteractionError('cancel', error);
      }
    } else if (interaction.commandName === 'monitor') {
      try {
        await monitorCommandExecute(interaction, db, tweetMonitor);
      } catch (error) {
        logInteractionError('monitor', error);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    activityTracker.track(message);
    const consumed = tweetMonitor ? await tweetMonitor.handleAwaitMessage(message) : false;
    if (consumed) return;
    await handleMessageCreate(message, downloadService, defaultMediaConfig);
  });

  return client;
}
