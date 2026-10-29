import { Client, GuildBasedChannel, SnowflakeUtil } from 'discord.js';
import { DiscordFetchService } from './discordService';
import { MediaDownloadService } from './mediaDownloadService';
import { MediaConfig } from '../types';
import { resetCancel } from './cancelManager';

const START_DELAY_MS = 10000;

export function lookbackSnowflake(nowMs: number, lookbackMs: number): string {
  return SnowflakeUtil.generate({ timestamp: nowMs - lookbackMs }).toString();
}

export function isWatchableChannel(channel: GuildBasedChannel): boolean {
  return channel.isTextBased() || channel.isVoiceBased();
}

export class DownloadWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private readonly intervalMs: number;
  private readonly lookbackMs: number;
  private readonly unreachable = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly fetchService: DiscordFetchService,
    private readonly downloadService: MediaDownloadService,
    private readonly mediaConfig: MediaConfig,
  ) {
    this.intervalMs = Math.max(parseInt(process.env.WATCHDOG_INTERVAL_SECONDS || '120', 10), 0) * 1000;
    this.lookbackMs = Math.max(parseInt(process.env.WATCHDOG_LOOKBACK_MINUTES || '30', 10), 1) * 60000;
  }

  start(): void {
    if (this.timer) return;
    if (this.intervalMs === 0) {
      console.log('[Watchdog] Disabled (WATCHDOG_INTERVAL_SECONDS=0)');
      return;
    }
    console.log(`[Watchdog] Every ${this.intervalMs / 1000}s, re-checking the last ${this.lookbackMs / 60000} min of messages`);
    setTimeout(() => void this.sweep(), START_DELAY_MS);
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // A failed embed scrape is memoised for the life of the process, so clear it
      // each tick — this is what turns a miss into a retry on the next sweep.
      this.downloadService.clearScrapeCache();

      const afterId = lookbackSnowflake(Date.now(), this.lookbackMs);
      let backfilled = 0;

      for (const guild of this.client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (!isWatchableChannel(channel)) continue;
          try {
            backfilled += await this.sweepChannel(channel, afterId);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (!this.unreachable.has(channel.id)) {
              this.unreachable.add(channel.id);
              console.warn(`[Watchdog] Skipping #${channel.name || channel.id}: ${msg}`);
            }
          }
        }
      }

      if (backfilled > 0) {
        console.log(`[Watchdog] Backfilled ${backfilled} missed file(s)`);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepChannel(channel: GuildBasedChannel, afterId: string): Promise<number> {
    // Cancels are per-channel flags cleared when a run starts (see download.ts);
    // a stale flag from an old /cancel would otherwise hide this channel forever.
    resetCancel(channel.id);

    const { messages } = await this.fetchService.fetchNewMessages(channel.id, afterId);
    if (messages.length === 0) return 0;

    const guildName = channel.guild.name;
    const channelName = channel.name;
    const parentChannelName = channel.isThread()
      ? channel.parent?.name || channel.parentId || undefined
      : undefined;

    const baseDir = await this.downloadService.renameIfNeeded(
      channel.guild.id, channel.id, guildName, channelName, parentChannelName,
    );

    let count = 0;
    for (const message of messages) {
      count += await this.downloadService.downloadNewMessageMedia(
        message, guildName, channelName, this.mediaConfig, parentChannelName, undefined, baseDir,
      );
    }

    if (count > 0) {
      console.log(`[Watchdog] Backfilled ${count} file(s) from #${channelName}`);
    }
    return count;
  }
}
