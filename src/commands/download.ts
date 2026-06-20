import { ChatInputCommandInteraction, SlashCommandBuilder, TextChannel, NewsChannel, ThreadChannel, ChannelType, MessageFlags, Message } from 'discord.js';
import { DiscordFetchService } from '../services/discordService';
import { MediaDownloadService } from '../services/mediaDownloadService';
import { FileService } from '../services/fileService';
import { DatabaseService } from '../services/databaseService';
import { formatBytes } from '../utils/mediaUtils';
import { safeEditReply } from '../utils/interactionUtils';
import { MediaConfig } from '../types';
import { resetCancel, resetGlobalCancel } from '../services/cancelManager';
import { SessionLogger } from '../utils/sessionLogger';

export const data = new SlashCommandBuilder()
  .setName('download')
  .setDescription('Download media from this channel')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Media type to download')
      .setRequired(false)
      .addChoices(
        { name: 'All', value: 'all' },
        { name: 'Images', value: 'images' },
        { name: 'Videos', value: 'videos' },
        { name: 'Audio', value: 'audio' },
      ))
  .addChannelOption(option =>
    option.setName('channel')
      .setDescription('Channel to scan (defaults to current)')
      .setRequired(false)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread))
  .addStringOption(option =>
    option.setName('channels')
      .setDescription('Multiple channels: #mentions or IDs (comma-separated)')
      .setRequired(false))
  .addBooleanOption(option =>
    option.setName('scan_all')
      .setDescription('Scan all accessible channels and active threads')
      .setRequired(false))
  .addIntegerOption(option =>
    option.setName('days')
      .setDescription('How far back to scan in days (0 = unlimited)')
      .setRequired(false)
      .setMinValue(0))
  .addIntegerOption(option =>
    option.setName('hours')
      .setDescription('How far back to scan in hours')
      .setRequired(false)
      .setMinValue(1))
  // TEMPORARY OPTIONS — will be removed when hours/days are sufficient
  .addIntegerOption(option =>
    option.setName('minutes')
      .setDescription('Minutes to scan back (temporary)')
      .setRequired(false)
      .setMinValue(1))
  .addIntegerOption(option =>
    option.setName('seconds')
      .setDescription('Seconds to scan back (temporary)')
      .setRequired(false)
      .setMinValue(1))
  .addIntegerOption(option =>
    option.setName('concurrency')
      .setDescription('Number of channels to process at once (default: 3)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(10));

export async function execute(
  interaction: ChatInputCommandInteraction,
  fetchService: DiscordFetchService,
  downloadService: MediaDownloadService,
  fileService: FileService,
  db: DatabaseService
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let interactionExpired = false;
  let lastDmMessage: Message | null = null;
  const reportStatus = async (msg: string): Promise<void> => {
    if (interactionExpired) {
      if (lastDmMessage) {
        try { await lastDmMessage.edit(msg); return; }
        catch { /* deleted or can't edit — send new */ }
      }
      try { lastDmMessage = await interaction.user.send(msg); }
      catch (e: any) { console.error(`Failed to send DM: ${e?.message ?? e}`); }
      return;
    }
    const ok = await safeEditReply(interaction, msg);
    if (!ok) {
      interactionExpired = true;
      try { lastDmMessage = await interaction.user.send(msg); }
      catch (e: any) { console.error(`Failed to send DM: ${e?.message ?? e}`); }
    }
  };

  const currentChannel = interaction.channel;
    if (!currentChannel) {
    await reportStatus('Could not identify this channel.');
    return;
  }

  // resolve target channels
  const scanAll = interaction.options.getBoolean('scan_all');
  const channelsStr = interaction.options.getString('channels');
  const pickerChannel = interaction.options.getChannel('channel');

  const targetChannels: (TextChannel | NewsChannel | ThreadChannel)[] = [];

  if (scanAll) {
    const guild = interaction.guild;
    if (!guild) {
      await reportStatus('`scan_all` can only be used in a server.');
      return;
    }
    await reportStatus('Fetching all accessible channels...');

    const botMember = guild.members.me;
    if (!botMember) {
      await reportStatus('Could not determine bot permissions.');
      return;
    }

    for (const ch of guild.channels.cache.values()) {
      if (ch instanceof ThreadChannel) {
        if (ch.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads'])) {
          targetChannels.push(ch);
        }
      } else if (ch instanceof TextChannel || ch instanceof NewsChannel) {
        if (ch.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory', 'SendMessages'])) {
          targetChannels.push(ch);
        }
      }
    }

    try {
      const activeThreads = await guild.channels.fetchActiveThreads();
      for (const th of activeThreads.threads.values()) {
        if (!(th instanceof ThreadChannel)) continue;
        if (targetChannels.some(t => t.id === th.id)) continue;
        if (th.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads'])) {
          targetChannels.push(th);
        }
      }
    } catch {
      // non-critical
    }
  } else if (channelsStr) {
    const ids = channelsStr.split(',').map(s => {
      const trimmed = s.trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^<#(\d+)>$/);
      return match ? match[1] : trimmed;
    }).filter(Boolean) as string[];

    for (const id of ids) {
      try {
        const ch = await interaction.client.channels.fetch(id);
        if (ch instanceof TextChannel || ch instanceof NewsChannel || ch instanceof ThreadChannel) {
          targetChannels.push(ch);
        }
      } catch {
        // skip unresolvable IDs
      }
    }
  } else if (pickerChannel instanceof TextChannel || pickerChannel instanceof NewsChannel || pickerChannel instanceof ThreadChannel) {
    targetChannels.push(pickerChannel);
  } else if (currentChannel instanceof TextChannel || currentChannel instanceof NewsChannel || currentChannel instanceof ThreadChannel) {
    targetChannels.push(currentChannel);
  }

  if (targetChannels.length === 0) {
    await reportStatus('No valid text channels specified.');
    return;
  }

  const typeChoice = interaction.options.getString('type') || 'all';

  const minutesOpt = interaction.options.getInteger('minutes');
  const secondsOpt = interaction.options.getInteger('seconds');
  const hoursOpt = interaction.options.getInteger('hours');
  const daysOpt = interaction.options.getInteger('days');

  const hasMinutesOrSeconds = (minutesOpt ?? 0) > 0 || (secondsOpt ?? 0) > 0;
  const hasCustom = hasMinutesOrSeconds || (hoursOpt ?? 0) > 0;

  const effectiveMinutes = minutesOpt || 0;
  const effectiveSeconds = secondsOpt || 0;
  const effectiveHours = hasMinutesOrSeconds ? 0 : (hoursOpt || 0);
  const effectiveDays = hasCustom ? 0 : (daysOpt ?? parseInt(process.env.MAX_BACKFILL_DAYS || '0', 10));

  const mediaConfig: MediaConfig = {
    images: typeChoice === 'all' || typeChoice.includes('images'),
    videos: typeChoice === 'all' || typeChoice.includes('videos'),
    audio: typeChoice === 'all' || typeChoice === 'audio',
    other: typeChoice === 'all',
  };

  const scopeLabel = buildScopeLabel(effectiveDays, effectiveHours, effectiveMinutes, effectiveSeconds);
  const concurrency = Math.min(Math.max(interaction.options.getInteger('concurrency') ?? 3, 1), 10);

  let totalMessages = 0;
  let totalMedia = 0;
  let totalSize = 0;
  let lastOutputPath: string | null = null;
  let hadError = false;

  resetGlobalCancel();

  let lastEdit = 0;
  const throttledStatus = (msg: string) => {
    const now = Date.now();
    if (now - lastEdit < 5000) return;
    lastEdit = now;
    reportStatus(msg);
  };

  const processChannel = async (
    targetChannel: TextChannel | NewsChannel | ThreadChannel,
    ci: number
  ): Promise<{ messages: number; media: number; size: number; outputPath: string } | null> => {
    const channelName = targetChannel.name || targetChannel.id;
    const guildId = targetChannel.guild?.id || 'unknown';
    const channelId = targetChannel.id;
    const guildName = targetChannel.guild?.name || 'Unknown';
    const parentChannelName = targetChannel instanceof ThreadChannel
      ? targetChannel.parent?.name || targetChannel.parentId || undefined
      : undefined;

    const prefix = targetChannels.length > 1 ? `[${ci + 1}/${targetChannels.length}] ` : '';

    try {
      resetCancel(channelId);
      let channelState = db.getChannelState(guildId, channelId);

      // If the previous download session didn't complete (e.g. process crash),
      // ignore stored state so we re-fetch messages that may have been missed
      if (channelState && !channelState.completed) {
        channelState = null;
      }

      db.markChannelIncomplete(guildId, channelId);

      const now = Date.now();
      const prevTs = channelState?.oldest_message_id
        ? discordSnowflakeToTimestamp(channelState.oldest_message_id)
        : 0;

      let beforeId: string | undefined;
      let afterId: string | undefined;
      const totalPrevMs = now - prevTs;
      const noTimeRange = effectiveDays === 0 && effectiveHours === 0 && effectiveMinutes === 0 && effectiveSeconds === 0;
      if (noTimeRange && channelState?.newest_message_id) {
        afterId = channelState.newest_message_id;
      } else if (prevTs > 0 && totalPrevMs > 0 && !noTimeRange) {
        const totalReqMs = (effectiveDays * 86400000) + (effectiveHours * 3600000) + (effectiveMinutes * 60000) + (effectiveSeconds * 1000);
        if (totalReqMs > totalPrevMs) {
          beforeId = channelState!.oldest_message_id ?? undefined;
        }
      }
      await reportStatus(`${prefix}Scanning #${channelName} (${scopeLabel})...`);

      const fetchResult = await fetchService.fetchAllChannelMessages(channelId, {
        days: effectiveDays,
        hours: effectiveHours,
        minutes: effectiveMinutes,
        seconds: effectiveSeconds,
        beforeId,
        afterId,
        onStatus: (msg) => throttledStatus(`${prefix}${msg}`),
      });

      if (fetchResult.messages.length === 0) {
        await reportStatus(`${prefix}#${channelName}: No new messages found.`);
        return null;
      }

      await reportStatus(`${prefix}#${channelName}: ${fetchResult.messages.length} messages with ${fetchResult.mediaCount} media files. Downloading...`);

      const logger = new SessionLogger(guildName, channelName, 'download');
      try {
        const result = await downloadService.downloadAllMedia(
          fetchResult.messages,
          guildName,
          channelName,
          mediaConfig,
          guildId,
          channelId,
          (msg) => throttledStatus(`${prefix}${msg}`),
          parentChannelName,
          concurrency,
          logger,
        );

        if (fetchResult.messages.length > 0) {
          const oldestMsg = fetchResult.messages[fetchResult.messages.length - 1];
          const newestMsg = fetchResult.messages[0];
          if (beforeId) {
            db.updateOldestMessageId(guildId, channelId, oldestMsg.id);
          } else {
            db.updateChannelState(guildId, channelId, oldestMsg.id, newestMsg.id);
          }
        }

        logger.close(`#${channelName}: ${result.mediaCount} files, ${formatBytes(result.totalBytes)}`);
        return {
          messages: fetchResult.messages.length,
          media: result.mediaCount,
          size: result.totalBytes,
          outputPath: result.outputPath,
        };
      } catch (error) {
        logger.close(`Error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    } catch (error) {
      hadError = true;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Download error in #${channelName}: ${msg}`);
      await reportStatus(`${prefix}#${channelName}: Failed - ${msg}`);
      return null;
    }
  };

  for (let i = 0; i < targetChannels.length; i += concurrency) {
    const batch = targetChannels.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((ch, idx) => processChannel(ch, i + idx))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        totalMessages += r.value.messages;
        totalMedia += r.value.media;
        totalSize += r.value.size;
        if (r.value.outputPath) lastOutputPath = r.value.outputPath;
      } else if (r.status === 'rejected') {
        hadError = true;
      }
    }
  }

  if (totalMessages === 0 && !hadError) {
    await reportStatus('No new messages found in any channel.');
    return;
  }

  await reportStatus(
    `Download complete!\n` +
    `- Channels: ${targetChannels.length}\n` +
    `- Messages scanned: ${totalMessages}\n` +
    `- Media files saved: ${totalMedia}\n` +
    `- Total size: ${formatBytes(totalSize)}\n` +
    `- Backfill: ${scopeLabel}\n` +
    (lastOutputPath ? `- Output: \`${lastOutputPath}\`` : '') +
    (hadError ? '\n- Some channels had errors (see above)' : '')
  );
}

function buildScopeLabel(days: number, hours: number, minutes: number, seconds: number): string {
  if (seconds > 0) return `${seconds}s`;
  if (minutes > 0) return `${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (days > 0) return `${days}d`;
  return 'all time';
}

function discordSnowflakeToTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + 1420070400000n);
}
