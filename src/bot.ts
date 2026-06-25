import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import { FileService } from './services/fileService';
import { DiscordFetchService } from './services/discordService';
import { MediaDownloadService } from './services/mediaDownloadService';
import { DatabaseService } from './services/databaseService';
import { MegaService } from './services/megaService';
import { DeferredDownloadQueue } from './services/deferredDownloadQueue';
import { MediaConfig, DownloadProgress } from './types';
import { execute as downloadCommandExecute } from './commands/download';
import { execute as cancelCommandExecute } from './commands/cancel';
import { handleMessageCreate } from './events/messageCreate';

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const DOWNLOAD_RETRIES = parseInt(process.env.DOWNLOAD_RETRIES || '3', 10);

const defaultMediaConfig: MediaConfig = {
  images: true,
  videos: true,
  audio: true,
  other: true,
};

export function createBot(): Client {
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

  const megaService = new MegaService();
  const deferredQueue = new DeferredDownloadQueue(DOWNLOAD_DIR);

  const noopProgress = (_progress: DownloadProgress) => {};

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
  }, DOWNLOAD_DIR, DOWNLOAD_RETRIES, megaService, deferredQueue);

  megaService.onConnect(() => {
    downloadService.processDeferredQueue(client).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Queue] processDeferredQueue error:', msg);
    });
  });
  megaService.connect().catch(() => {});

  // Fallback: if MEGA never connects, flush the deferred queue after 60s (download only, no upload)
  setTimeout(() => {
    if (!megaService.isConnected() && deferredQueue.count() > 0) {
      console.log(`[Queue] MEGA not connected after 60s, flushing ${deferredQueue.count()} deferred item(s) without upload`);
      downloadService.processDeferredQueue(client).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Queue] fallback flush error:', msg);
      });
    }
  }, 60000);

  client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag}`);
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
    await handleMessageCreate(message, downloadService, defaultMediaConfig);
  });

  return client;
}
