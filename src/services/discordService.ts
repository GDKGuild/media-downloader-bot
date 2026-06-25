import { Client, Collection, Message, TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
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

    if (!(channel instanceof TextChannel || channel instanceof DMChannel || channel instanceof NewsChannel || channel instanceof ThreadChannel)) {
      throw new Error(`Channel ${channelId} is not a text-based channel`);
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

      const fetchOpts: { limit: number; before?: string } = { limit: 100 };
      if (lastId) fetchOpts.before = lastId;

      const messages = await channel.messages.fetch(fetchOpts);
      const count = messages.size;

      if (count === 0) break;

      const messageArray = Array.from(messages.values());

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
    if (!(channel instanceof TextChannel || channel instanceof DMChannel || channel instanceof NewsChannel || channel instanceof ThreadChannel)) {
      throw new Error(`Channel ${channelId} is not a text-based channel`);
    }

    const allMessages: Message[] = [];
    let lastId = afterId;
    let mediaCount = 0;

    for (;;) {
      if (isCancelled(channelId)) break;

      const messages = await channel.messages.fetch({ after: lastId, limit: 100 });
      const count = messages.size;
      if (count === 0) break;

      const messageArray = Array.from(messages.values());
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
