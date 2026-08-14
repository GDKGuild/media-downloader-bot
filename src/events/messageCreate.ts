import { Message, TextChannel, NewsChannel, ThreadChannel, DMChannel, VoiceChannel } from 'discord.js';
import { MediaDownloadService } from '../services/mediaDownloadService';
import { MediaConfig } from '../types';
import { extractMediaFromMessage } from '../utils/mediaUtils';

const AUTO_DOWNLOAD = process.env.AUTO_DOWNLOAD !== 'false';

export async function handleMessageCreate(
  message: Message,
  mediaDownloadService: MediaDownloadService,
  mediaConfig: MediaConfig
): Promise<void> {
  if (!AUTO_DOWNLOAD) return;
  const isOwnRelay = message.author.bot
    && message.author.id === message.client.user?.id
    && /https?:\/\/[^\s]+\/status\/\d+/i.test(message.content);
  if (message.author.bot && !isOwnRelay) return;

  const hasUrls = /https?:\/\/[^\s]+/.test(message.content);

  let entries = extractMediaFromMessage(message, 0, mediaConfig);
  let hasScrapeableEmbed = message.embeds.some(e => !!e.url);

  // Discord generates embeds asynchronously after MessageCreate, so the
  // initial payload may have no embeds even for URL messages. Wait and
  // re-fetch to give Discord time to populate embed data.
  if (entries.length === 0 && !hasScrapeableEmbed && hasUrls && !message.channel.isDMBased()) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      await message.fetch();
    } catch {
      return;
    }
    entries = extractMediaFromMessage(message, 0, mediaConfig);
    hasScrapeableEmbed = message.embeds.some(e => !!e.url);
  }

  if (entries.length === 0 && !hasScrapeableEmbed) return;

  const channel = message.channel;
  if (!(channel instanceof TextChannel || channel instanceof NewsChannel || channel instanceof ThreadChannel || channel instanceof DMChannel || channel instanceof VoiceChannel)) return;

  const guildName = channel instanceof DMChannel
    ? `DM-${channel.recipient?.username || 'unknown'}`
    : (channel as TextChannel | NewsChannel | ThreadChannel | VoiceChannel).guild?.name || 'Unknown';

  const channelName = (channel as TextChannel | NewsChannel | ThreadChannel | VoiceChannel).name || channel.id;

  const parentChannelName = channel instanceof ThreadChannel
    ? channel.parent?.name || channel.parentId || undefined
    : undefined;

  try {
    const guildId = message.guild?.id;
    const channelId = message.channel.id;

    // Resolve folder, handling renames
    const resolvedBaseDir = guildId
      ? await mediaDownloadService.renameIfNeeded(guildId, channelId, guildName, channelName, parentChannelName)
      : undefined;

    const count = await mediaDownloadService.downloadNewMessageMedia(
      message,
      guildName,
      channelName,
      mediaConfig,
      parentChannelName,
      resolvedBaseDir,
    );

    if (count > 0) {
      console.log(`[Auto] Downloaded ${count} file(s) from "${channelName}"`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Auto] Failed to download media from ${channelName}: ${msg}`);
  }
}
