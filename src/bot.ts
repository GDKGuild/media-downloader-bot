import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { FileService } from './services/fileService';
import { DiscordFetchService } from './services/discordService';
import { MediaDownloadService } from './services/mediaDownloadService';
import { DatabaseService } from './services/databaseService';
import { MegaService } from './services/megaService';
import { DeferredDownloadQueue } from './services/deferredDownloadQueue';
import { StorageService } from './services/storageService';
import { MediaConfig, DownloadProgress } from './types';
import { execute as downloadCommandExecute } from './commands/download';
import { execute as cancelCommandExecute } from './commands/cancel';
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

export function getActivityTracker(): ActivityTracker {
  return activityTracker;
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
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const ownerId = process.env.BOT_OWNER_ID;
    if (ownerId && interaction.user.id !== ownerId) {
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
        console.error('Unhandled interaction error:', error);
      }
    } else if (interaction.commandName === 'cancel') {
      try {
        await cancelCommandExecute(interaction);
      } catch (error) {
        console.error('Unhandled interaction error:', error);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    activityTracker.track(message);
    await handleMessageCreate(message, downloadService, defaultMediaConfig);
  });

  return client;
}
