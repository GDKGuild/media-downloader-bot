import { Client, Collection, Message, TextChannel, DMChannel, NewsChannel, ThreadChannel, VoiceChannel, ForumChannel, Routes, ChannelType } from 'discord.js';
import { DownloadProgress, FetchOptions } from '../types';
import { shouldDownloadFile, countMedia } from '../utils/mediaUtils';
import { isCancelled } from './cancelManager';

export interface FetchResult {
  messages: Message[];
  mediaCount: number;
}

export class DiscordFetchService {
  private client: Client;
  private onProgress: (progress: DownloadProgress) => void;

  constructor(client: Client, onProgress?: (progress: DownloadProgress) => void) {
    this.client = client;
    this.onProgress = onProgress || (() => {});
  }

  async fetchAllChannelMessages(
    channelId: string,
    options?: FetchOptions
  ): Promise<FetchResult> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const isVoice = channel instanceof VoiceChannel;
    const isTextBased = channel instanceof TextChannel || channel instanceof DMChannel || channel instanceof NewsChannel || channel instanceof ThreadChannel;
    if (!isVoice && !isTextBased) {
      throw new Error(`Channel ${channelId} is not a text-based or voice channel`);
    }

    const allMessages: Message[] = [];
    let lastId: string | undefined = options?.beforeId;
    const afterId = options?.afterId;
    let mediaCount = 0;
    const totalMs = ((options?.days || 0) * 86400000)
      + ((options?.hours || 0) * 3600000)
      + ((options?.minutes || 0) * 60000)
      + ((options?.seconds || 0) * 1000);
    const lowerBound = options?.afterTimestamp || (totalMs > 0 ? Date.now() - totalMs : 0);
    const upperBound = options?.beforeTimestamp || 0;

    for (;;) {
      if (isCancelled(channelId)) {
        this.onProgress({
          stage: 'fetching',
          current: allMessages.length,
          total: 0,
          message: 'Cancelled',
        });
        break;
      }

      let messageArray: Message[];

      if (isVoice) {
        messageArray = await this.fetchVoiceChannelMessages(channelId, 100, lastId);
      } else {
        const fetchOpts: { limit: number; before?: string } = { limit: 100 };
        if (lastId) fetchOpts.before = lastId;
        const messages = await (channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).messages.fetch(fetchOpts);
        messageArray = Array.from(messages.values());
      }

      const count = messageArray.length;

      if (count === 0) break;

      // Upper bound: skip batches where even the oldest message is newer than beforeTimestamp
      if (upperBound > 0 && messageArray[messageArray.length - 1].createdTimestamp > upperBound) {
        lastId = messageArray[messageArray.length - 1].id;
        await this.delay(1100);
        continue;
      }

      // Filter out messages newer than beforeTimestamp
      let batch = messageArray;
      if (upperBound > 0) {
        batch = messageArray.filter(m => m.createdTimestamp <= upperBound);
      }

      // Lower bound: stop when oldest message in batch is older than afterTimestamp
      if (lowerBound > 0 && batch[batch.length - 1].createdTimestamp < lowerBound) {
        const filtered = batch.filter(m => m.createdTimestamp >= lowerBound);
        if (filtered.length > 0) {
          allMessages.push(...filtered);
          mediaCount += countMedia(filtered);
          this.onProgress({
            stage: 'fetching',
            current: allMessages.length,
            total: 0,
            message: `Reached cutoff, fetched ${allMessages.length} messages`,
          });
        }
        break;
      }

      // stop if we've reached already-scanned messages (afterId is the newest known)
      if (afterId && BigInt(batch[batch.length - 1].id) <= BigInt(afterId)) {
        const filtered = batch.filter(m => BigInt(m.id) > BigInt(afterId));
        if (filtered.length > 0) {
          allMessages.push(...filtered);
          mediaCount += countMedia(filtered);
        }
        break;
      }

      allMessages.push(...batch);
      mediaCount += countMedia(batch);

      const statusMsg = `Fetched ${allMessages.length} messages, found ${mediaCount} media files`;
      this.onProgress({
        stage: 'fetching',
        current: allMessages.length,
        total: 0,
        message: statusMsg,
      });
      if (options?.onStatus) options.onStatus(statusMsg);

      lastId = batch[batch.length - 1].id;

      await this.delay(1100);
    }

    return { messages: allMessages, mediaCount };
  }

  async fetchNewMessages(
    channelId: string,
    afterId: string,
    onStatus?: (msg: string) => void,
  ): Promise<FetchResult> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const isVoice = channel instanceof VoiceChannel;
    const isTextBased = channel instanceof TextChannel || channel instanceof DMChannel || channel instanceof NewsChannel || channel instanceof ThreadChannel;
    if (!isVoice && !isTextBased) {
      throw new Error(`Channel ${channelId} is not a text-based or voice channel`);
    }

    const allMessages: Message[] = [];
    let lastId = afterId;
    let mediaCount = 0;

    for (;;) {
      if (isCancelled(channelId)) break;

      let messageArray: Message[];

      if (isVoice) {
        messageArray = await this.fetchVoiceChannelMessages(channelId, 100, undefined, lastId);
      } else {
        const messages = await (channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).messages.fetch({ after: lastId, limit: 100 });
        messageArray = Array.from(messages.values());
      }

      const count = messageArray.length;
      if (count === 0) break;

      allMessages.push(...messageArray);
      mediaCount += countMedia(messageArray);

      const statusMsg = `Fetched ${allMessages.length} new messages, found ${mediaCount} media files`;
      this.onProgress({
        stage: 'fetching',
        current: allMessages.length,
        total: 0,
        message: statusMsg,
      });
      if (onStatus) onStatus(statusMsg);

      lastId = messageArray[0].id;

      await this.delay(1100);
    }

    return { messages: allMessages, mediaCount };
  }

  async fetchForumThreads(channelId: string): Promise<ThreadChannel[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof ForumChannel)) {
      throw new Error(`Channel ${channelId} is not a forum channel`);
    }

    const threads: ThreadChannel[] = [];

    try {
      const active = await channel.threads.fetchActive();
      threads.push(...active.threads.values());
    } catch { /* non-critical */ }

    try {
      let archived = await channel.threads.fetchArchived();
      threads.push(...archived.threads.values());
      while (archived.hasMore && archived.threads.size > 0) {
        archived = await channel.threads.fetchArchived({ before: archived.threads.lastKey()! });
        threads.push(...archived.threads.values());
      }
    } catch { /* non-critical */ }

    return threads;
  }

  async fetchChannelThreads(channelId: string): Promise<ThreadChannel[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) return [];
    if (channel instanceof ForumChannel) {
      return this.fetchForumThreads(channelId);
    }
    if (!(channel instanceof TextChannel || channel instanceof NewsChannel)) {
      return [];
    }

    const threads: ThreadChannel[] = [];

    try {
      const active = await channel.threads.fetchActive();
      threads.push(...active.threads.values());
    } catch { /* non-critical */ }

    try {
      let archived = await channel.threads.fetchArchived();
      threads.push(...archived.threads.values());
      while (archived.hasMore && archived.threads.size > 0) {
        archived = await channel.threads.fetchArchived({ before: archived.threads.lastKey()! });
        threads.push(...archived.threads.values());
      }
    } catch { /* non-critical */ }

    return threads;
  }

  private async fetchVoiceChannelMessages(
    channelId: string,
    limit: number,
    before?: string,
    after?: string,
  ): Promise<Message[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    if (after) params.set('after', after);

    const data = await this.client.rest.get(Routes.channelMessages(channelId), { query: params });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MessageCtor = Message as unknown as new (client: Client, data: any) => Message;
    return (data as unknown[]).map((raw) => new MessageCtor(this.client, raw));
  }

  async fetchGuildChannels(guildId: string): Promise<Collection<string, TextChannel>> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) throw new Error(`Guild ${guildId} not found`);

    const channels = await guild.channels.fetch();
    return channels.filter(
      (c): c is TextChannel => c instanceof TextChannel
    ) as Collection<string, TextChannel>;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
