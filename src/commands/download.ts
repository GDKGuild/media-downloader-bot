import { ChatInputCommandInteraction, SlashCommandBuilder, TextChannel, NewsChannel, ThreadChannel, VoiceChannel, ForumChannel, ChannelType, MessageFlags, Message } from 'discord.js';
import { DiscordFetchService } from '../services/discordService';
import { MediaDownloadService } from '../services/mediaDownloadService';
import { FileService } from '../services/fileService';
import { DatabaseService } from '../services/databaseService';
import { formatBytes } from '../utils/mediaUtils';
import { safeEditReply } from '../utils/interactionUtils';
import { MediaConfig } from '../types';
import { resetCancel, resetGlobalCancel } from '../services/cancelManager';

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
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildVoice, ChannelType.GuildForum))
  .addStringOption(option =>
    option.setName('channels')
      .setDescription('Multiple channels: #mentions or IDs (comma-separated)')
      .setRequired(false))
  .addBooleanOption(option =>
    option.setName('scan_all')
      .setDescription('Scan all accessible channels and active threads')
      .setRequired(false))
  .addBooleanOption(option =>
    option.setName('voice_only')
      .setDescription('Scan all accessible voice channels only')
      .setRequired(false))
  .addBooleanOption(option =>
    option.setName('thread_only')
      .setDescription('Scan threads of the selected channel(s) instead of the channels (requires channel/channels)')
      .setRequired(false))
  .addStringOption(option =>
    option.setName('thread')
      .setDescription('Scan only the thread with this name in the selected channel(s)')
      .setRequired(false))
  .addIntegerOption(option =>
    option.setName('days')
      .setDescription('Days to look back (combine with other time options)')
      .setRequired(false)
      .setMinValue(0))
  .addIntegerOption(option =>
    option.setName('hours')
      .setDescription('Hours to look back (combine with other time options)')
      .setRequired(false)
      .setMinValue(0))
  .addIntegerOption(option =>
    option.setName('minutes')
      .setDescription('Minutes to look back (combine with other time options)')
      .setRequired(false)
      .setMinValue(0))
  .addIntegerOption(option =>
    option.setName('seconds')
      .setDescription('Seconds to look back (combine with other time options)')
      .setRequired(false)
      .setMinValue(0))
  .addStringOption(option =>
    option.setName('after')
      .setDescription('Download messages after this date (YYYY-MM-DD)')
      .setRequired(false))
  .addStringOption(option =>
    option.setName('before')
      .setDescription('Download messages before this date (YYYY-MM-DD)')
      .setRequired(false))
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
  const voiceOnly = interaction.options.getBoolean('voice_only');
  const threadOnly = interaction.options.getBoolean('thread_only');
  const threadName = interaction.options.getString('thread');
  const channelsStr = interaction.options.getString('channels');
  const pickerChannel = interaction.options.getChannel('channel');

  // thread options only apply when channel/channels are explicitly provided
  const useThreads = (threadOnly || !!threadName) && (!!channelsStr || !!pickerChannel);

  const targetChannels: (TextChannel | NewsChannel | ThreadChannel | VoiceChannel)[] = [];

  const resolveThreadTargets = async (channel: TextChannel | NewsChannel | ForumChannel): Promise<ThreadChannel[]> => {
    const threads = await fetchService.fetchChannelThreads(channel.id);
    if (threadName) {
      const needle = threadName.trim().toLowerCase();
      return threads.filter(t => t.name.toLowerCase() === needle);
    }
    return threads;
  };

  if (voiceOnly) {
    const guild = interaction.guild;
    if (!guild) {
      await reportStatus('`voice_only` can only be used in a server.');
      return;
    }
    await reportStatus('Fetching all accessible voice channels...');

    const botMember = guild.members.me;
    if (!botMember) {
      await reportStatus('Could not determine bot permissions.');
      return;
    }

    for (const ch of guild.channels.cache.values()) {
      if (ch instanceof VoiceChannel && ch.permissionsFor(botMember).has(['ViewChannel', 'Connect'])) {
        targetChannels.push(ch);
      }
    }
  } else if (scanAll) {
    const guild = interaction.guild;
    if (!guild) {
      await reportStatus('`scan_all` can only be used in a server.');
      return;
    }

    const scanAllThreads = threadOnly || !!threadName;
    await reportStatus(scanAllThreads ? 'Fetching all accessible threads...' : 'Fetching all accessible channels...');

    const botMember = guild.members.me;
    if (!botMember) {
      await reportStatus('Could not determine bot permissions.');
      return;
    }

    const pushThreadIfAccessible = (thread: ThreadChannel): void => {
      if (thread.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads'])) {
        targetChannels.push(thread);
      }
    };

    if (scanAllThreads) {
      for (const ch of guild.channels.cache.values()) {
        if (!(ch instanceof TextChannel || ch instanceof NewsChannel || ch instanceof ForumChannel)) continue;
        if (!ch.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory'])) continue;
        try {
          const threads = await resolveThreadTargets(ch);
          for (const thread of threads) {
            pushThreadIfAccessible(thread);
          }
        } catch { /* non-critical */ }
      }

      try {
        const activeThreads = await guild.channels.fetchActiveThreads();
        for (const th of activeThreads.threads.values()) {
          if (!(th instanceof ThreadChannel)) continue;
          if (targetChannels.some(t => t.id === th.id)) continue;
          if (threadName && th.name.toLowerCase() !== threadName.trim().toLowerCase()) continue;
          pushThreadIfAccessible(th);
        }
      } catch {
        // non-critical
      }
    } else {
      for (const ch of guild.channels.cache.values()) {
        if (ch instanceof ThreadChannel) {
          if (ch.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads'])) {
            targetChannels.push(ch);
          }
        } else if (ch instanceof VoiceChannel) {
          if (ch.permissionsFor(botMember).has(['ViewChannel', 'Connect'])) {
            targetChannels.push(ch);
          }
        } else if (ch instanceof ForumChannel) {
          if (ch.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory'])) {
            try {
              const threads = await fetchService.fetchForumThreads(ch.id);
              for (const thread of threads) {
                if (thread.permissionsFor(botMember).has(['ViewChannel', 'ReadMessageHistory', 'SendMessagesInThreads'])) {
                  targetChannels.push(thread);
                }
              }
            } catch { /* non-critical */ }
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
        if (ch instanceof ForumChannel) {
          const threads = useThreads
            ? await resolveThreadTargets(ch)
            : await fetchService.fetchForumThreads(ch.id);
          for (const thread of threads) {
            targetChannels.push(thread);
          }
        } else if (ch instanceof TextChannel || ch instanceof NewsChannel) {
          if (useThreads) {
            const threads = await resolveThreadTargets(ch);
            for (const thread of threads) {
              targetChannels.push(thread);
            }
          } else {
            targetChannels.push(ch);
          }
        } else if (ch instanceof ThreadChannel || ch instanceof VoiceChannel) {
          targetChannels.push(ch);
        }
      } catch {
        // skip unresolvable IDs
      }
    }
  } else {
    const source = pickerChannel || currentChannel;
    if (source instanceof ForumChannel) {
      const threads = useThreads
        ? await resolveThreadTargets(source)
        : await fetchService.fetchForumThreads(source.id);
      for (const thread of threads) {
        targetChannels.push(thread);
      }
    } else if (source instanceof TextChannel || source instanceof NewsChannel) {
      if (useThreads) {
        const threads = await resolveThreadTargets(source);
        for (const thread of threads) {
          targetChannels.push(thread);
        }
      } else {
        targetChannels.push(source);
      }
    } else if (source instanceof ThreadChannel || source instanceof VoiceChannel) {
      targetChannels.push(source);
    }
  }

  if (targetChannels.length === 0) {
    if (useThreads && threadName) {
      await reportStatus(`No thread named "${threadName}" found in the selected channel(s).`);
    } else {
      await reportStatus('No valid channels specified.');
    }
    return;
  }

  const typeChoice = interaction.options.getString('type') || 'all';

  const minutesOpt = interaction.options.getInteger('minutes');
  const secondsOpt = interaction.options.getInteger('seconds');
  const hoursOpt = interaction.options.getInteger('hours');
  const daysOpt = interaction.options.getInteger('days');

  const effectiveMinutes = minutesOpt || 0;
  const effectiveSeconds = secondsOpt || 0;
  const effectiveHours = hoursOpt || 0;

  // When no time params given, fall back to env var default; otherwise use explicit value
  const hasAnyTimeParam = minutesOpt !== null || secondsOpt !== null || hoursOpt !== null || daysOpt !== null;
  const effectiveDays = hasAnyTimeParam
    ? (daysOpt || 0)
    : parseInt(process.env.MAX_BACKFILL_DAYS || '0', 10);

  const afterStr = interaction.options.getString('after');
  const beforeStr = interaction.options.getString('before');

  let afterTimestamp = 0;
  let beforeTimestamp = 0;

  if (afterStr) {
    const d = new Date(afterStr + 'T00:00:00.000Z');
    if (isNaN(d.getTime())) {
      await reportStatus('Invalid `after` date. Use YYYY-MM-DD format (e.g. 2026-03-01).');
      return;
    }
    afterTimestamp = d.getTime() + 86400000;
  }

  if (beforeStr) {
    const d = new Date(beforeStr + 'T00:00:00.000Z');
    if (isNaN(d.getTime())) {
      await reportStatus('Invalid `before` date. Use YYYY-MM-DD format (e.g. 2026-04-01).');
      return;
    }
    beforeTimestamp = d.getTime();
  }

  if (afterTimestamp && beforeTimestamp && afterTimestamp >= beforeTimestamp) {
    await reportStatus('`after` must be before `before`.');
    return;
  }

  const useDateRange = afterTimestamp > 0 || beforeTimestamp > 0;

  const mediaConfig: MediaConfig = {
    images: typeChoice === 'all' || typeChoice.includes('images'),
    videos: typeChoice === 'all' || typeChoice.includes('videos'),
    audio: typeChoice === 'all' || typeChoice === 'audio',
    other: typeChoice === 'all',
  };

  const scopeLabel = useDateRange
    ? `${afterStr || 'beginning'} → ${beforeStr || 'now'}`
    : buildScopeLabel(effectiveDays, effectiveHours, effectiveMinutes, effectiveSeconds);
  const concurrency = Math.min(Math.max(interaction.options.getInteger('concurrency') ?? 3, 1), 10);

  let totalMessages = 0;
  let totalMedia = 0;
  let totalSize = 0;
  let lastOutputPath: string | null = null;
  let hadError = false;
  const channelResults: { baseDir: string; megaBasePath: string }[] = [];

  resetGlobalCancel();

  let lastEdit = 0;
  const throttledStatus = (msg: string) => {
    const now = Date.now();
    if (now - lastEdit < 5000) return;
    lastEdit = now;
    reportStatus(msg);
  };

  const processChannel = async (
    targetChannel: TextChannel | NewsChannel | ThreadChannel | VoiceChannel,
    ci: number
  ): Promise<{ messages: number; media: number; size: number; outputPath: string; baseDir: string; megaBasePath: string } | null> => {
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

      const sGuild = guildName;
      const sChannel = channelName;
      const sParent = parentChannelName || null;
      db.markChannelIncomplete(guildId, channelId, sGuild, sChannel, sParent);

      // Resolve folder, handling renames
      const resolvedBaseDir = await downloadService.renameIfNeeded(
        guildId, channelId, guildName, channelName, parentChannelName,
      );

      const hasTimeRange = effectiveDays > 0 || effectiveHours > 0 || effectiveMinutes > 0 || effectiveSeconds > 0;
      const totalReqMs = hasTimeRange
        ? (effectiveDays * 86400000) + (effectiveHours * 3600000) + (effectiveMinutes * 60000) + (effectiveSeconds * 1000)
        : 0;

      let forwardAfterId: string | undefined;
      let backwardBeforeId: string | undefined;
      let doForward = false;
      let doBackward = false;

      if (useDateRange) {
        const beforeSnowflake = beforeTimestamp ? timestampToSnowflake(beforeTimestamp) : null;

        // Backward fetch from before-bound, stopping at after-bound (handled by fetchAllChannelMessages)
        if (beforeTimestamp) {
          backwardBeforeId = beforeSnowflake!;
        }
        // else (only after): backwardBeforeId stays undefined, starts from newest
        doBackward = true;
      } else if (hasTimeRange) {
        const cutoffTs = Date.now() - totalReqMs;
        const cutoffSnowflake = timestampToSnowflake(cutoffTs);

        if (channelState?.newest_message_id) {
          if (BigInt(cutoffSnowflake) > BigInt(channelState.newest_message_id)) {
            forwardAfterId = cutoffSnowflake;
          } else {
            forwardAfterId = channelState.newest_message_id;
          }
          doForward = true;
        }

        if (!channelState?.oldest_message_id || BigInt(cutoffSnowflake) < BigInt(channelState.oldest_message_id)) {
          backwardBeforeId = channelState?.oldest_message_id ?? undefined;
          doBackward = true;
        }

        if (!channelState) {
          doBackward = true;
        }
      } else {
        // No time parameters: always rescan the full history to the very beginning,
        // regardless of previously stored scan state.
        doBackward = true;
      }

      const allMessages: Message[] = [];
      let totalMediaCount = 0;

      if (doForward) {
        await reportStatus(`${prefix}Scanning #${channelName} (${scopeLabel})...`);
        const forwardResult = await fetchService.fetchNewMessages(
          channelId, forwardAfterId!,
          (msg) => throttledStatus(`${prefix}${msg}`),
        );
        allMessages.push(...forwardResult.messages);
        totalMediaCount += forwardResult.mediaCount;
      }

      if (doBackward) {
        await reportStatus(`${prefix}Scanning #${channelName} (${scopeLabel})...`);
        const fetchResult = await fetchService.fetchAllChannelMessages(channelId, {
          days: effectiveDays,
          hours: effectiveHours,
          minutes: effectiveMinutes,
          seconds: effectiveSeconds,
          beforeId: backwardBeforeId,
          afterTimestamp: afterTimestamp || undefined,
          beforeTimestamp: beforeTimestamp || undefined,
          onStatus: (msg) => throttledStatus(`${prefix}${msg}`),
        });
        allMessages.push(...fetchResult.messages);
        totalMediaCount += fetchResult.mediaCount;
      }

      if (allMessages.length === 0) {
        await reportStatus(`${prefix}#${channelName}: No new messages found.`);
        return null;
      }

      await reportStatus(`${prefix}#${channelName}: ${allMessages.length} messages with ${totalMediaCount} media files. Downloading...`);

      try {
        const result = await downloadService.downloadAllMedia(
          allMessages,
          guildName,
          channelName,
          mediaConfig,
          guildId,
          channelId,
          (msg) => throttledStatus(`${prefix}${msg}`),
          parentChannelName,
          concurrency,
          targetChannels.length > 1,
          resolvedBaseDir,
        );

        if (allMessages.length > 0) {
          let minId = allMessages[0].id;
          let maxId = allMessages[0].id;
          for (const msg of allMessages) {
            if (BigInt(msg.id) < BigInt(minId)) minId = msg.id;
            if (BigInt(msg.id) > BigInt(maxId)) maxId = msg.id;
          }
          db.updateChannelState(guildId, channelId, minId, maxId, sGuild, sChannel, sParent);
        }

        return {
          messages: allMessages.length,
          media: result.mediaCount,
          size: result.totalBytes,
          outputPath: result.outputPath,
          baseDir: result.outputPath,
          megaBasePath: result.megaBasePath,
        };
      } catch (error) {
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
        channelResults.push({ baseDir: r.value.baseDir, megaBasePath: r.value.megaBasePath });
      } else if (r.status === 'rejected') {
        hadError = true;
      }
    }
  }

  if (totalMessages === 0 && !hadError) {
    await reportStatus('No new messages found in any channel.');
    return;
  }

  const storageLabel = downloadService.storageService?.getStorageLabel();
  const storageLine = storageLabel ? `\n- Storage: ${storageLabel}` : '';

  await reportStatus(
    `Download complete!\n` +
    `- Channels: ${targetChannels.length}\n` +
    `- Messages scanned: ${totalMessages}\n` +
    `- Media files saved: ${totalMedia}\n` +
    `- Total size: ${formatBytes(totalSize)}\n` +
    `- Backfill: ${scopeLabel}\n` +
    (lastOutputPath ? `- Output: \`${lastOutputPath}\`` : '') +
    storageLine +
    (hadError ? '\n- Some channels had errors (see above)' : '')
  );

  if (!downloadService.storageService && targetChannels.length > 1 && channelResults.length > 0 && downloadService.megaService?.isConnected()) {
    const total = channelResults.length;
    await reportStatus(`Downloads complete!\nUploading to MEGA... (0/${total})`);
    let uploadOk = 0;
    let uploadFail = 0;
    for (let i = 0; i < total; i++) {
      const ch = channelResults[i];
      await reportStatus(`Uploading to MEGA... (${i + 1}/${total})`);
      try {
        await downloadService.megaService.uploadDirectoryAndClean(ch.baseDir, ch.megaBasePath);
        uploadOk++;
      } catch (err: unknown) {
        uploadFail++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`MEGA upload failed for ${ch.megaBasePath}: ${msg}`);
      }
    }
    if (uploadFail === 0) {
      await reportStatus(`Upload complete!\n${uploadOk} channel(s) uploaded to MEGA.`);
    } else {
      await reportStatus(`Upload completed with ${uploadFail} error(s). ${uploadOk} channel(s) uploaded.`);
    }
  }
}

function buildScopeLabel(days: number, hours: number, minutes: number, seconds: number): string {
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.length > 0 ? parts.join(' ') : 'all time';
}

function discordSnowflakeToTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + 1420070400000n);
}

function timestampToSnowflake(ts: number): string {
  return ((BigInt(ts) - 1420070400000n) << 22n).toString();
}
