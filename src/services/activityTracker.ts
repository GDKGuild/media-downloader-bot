import * as fs from 'fs';
import * as path from 'path';
import { Message, TextChannel, NewsChannel, ThreadChannel, DMChannel, VoiceChannel, GuildMember } from 'discord.js';
import { extractMediaFromMessage } from '../utils/mediaUtils';
import {
  ActivityConfig,
  UserActivityState,
  ChatSession,
  MediaBreakdown,
  MediaStats,
  createEmptyMediaBreakdown,
} from '../types/activity';

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

const ACTIVITY_DIR = 'activity-logs';
const FLUSH_INTERVAL_MS = 60_000;

export class ActivityTracker {
  private config: ActivityConfig;
  private state = new Map<string, UserActivityState>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ActivityConfig) {
    this.config = config;
  }

  startFlushInterval(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  stopFlushInterval(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  track(message: Message): void {
    if (message.author.bot) return;

    const msgDate = new Date(message.createdTimestamp);
    const dateStr = formatDate(msgDate);
    const key = `${message.author.id}|${dateStr}`;

    let existing = this.state.get(key);
    if (existing && existing.date !== dateStr) {
      this.flushState(key, existing);
      existing = undefined;
    }

    const globalName = message.author.globalName || message.author.username;
    const member = message.member instanceof GuildMember ? message.member : null;
    const serverName = member?.nickname || globalName;
    const guildName = message.guild?.name || 'DM';
    const guildId = message.guild?.id || 'dm';

    if (!existing) {
      existing = {
        userId: message.author.id,
        username: message.author.username,
        globalName,
        serverName,
        guildName,
        guildId,
        date: dateStr,
        messageCount: 0,
        timestamps: [],
        mediaCounts: createEmptyMediaBreakdown(),
        sessions: [],
      };
      this.state.set(key, existing);
    } else {
      existing.username = message.author.username;
      existing.globalName = globalName;
      existing.serverName = serverName;
      existing.guildName = guildName;
      existing.guildId = guildId;
    }

    existing.messageCount++;
    existing.timestamps.push(msgDate);

    this.countMedia(message, existing.mediaCounts);

    if (this.config.advancedMode) {
      this.updateSessions(message, msgDate, existing);
    }
  }

  private countMedia(message: Message, counts: MediaBreakdown): void {
    const entries = extractMediaFromMessage(message, 0);
    for (const entry of entries) {
      const bucket = this.getMediaBucket(entry.type);
      this.incrementStat(bucket, entry.category, counts);
    }
  }

  private getMediaBucket(
    type: string
  ): keyof Pick<MediaBreakdown, 'attachments' | 'embedImages' | 'embedVideos' | 'embedThumbnails'> {
    switch (type) {
      case 'attachment':
        return 'attachments';
      case 'embed-image':
        return 'embedImages';
      case 'embed-video':
        return 'embedVideos';
      case 'embed-thumbnail':
        return 'embedThumbnails';
      default:
        return 'attachments';
    }
  }

  private incrementStat(
    bucket: keyof MediaBreakdown,
    category: string,
    counts: MediaBreakdown
  ): void {
    const stats = counts[bucket];
    switch (category) {
      case 'images':
        stats.images++;
        break;
      case 'videos':
        stats.videos++;
        break;
      case 'audio':
        stats.audio++;
        break;
      default:
        stats.other++;
        break;
    }
  }

  private updateSessions(message: Message, msgDate: Date, state: UserActivityState): void {
    const channel = message.channel;
    let channelName = channel.id;
    let channelParent: string | undefined;

    if (channel instanceof TextChannel || channel instanceof NewsChannel || channel instanceof VoiceChannel) {
      channelName = channel.name;
    } else if (channel instanceof ThreadChannel) {
      channelName = channel.name;
      channelParent = channel.parent?.name || channel.parentId || undefined;
    } else if (channel instanceof DMChannel) {
      channelName = `DM-${channel.recipient?.username || 'unknown'}`;
    }

    const sessions = state.sessions;
    const lastSession = sessions[sessions.length - 1];

    if (lastSession && msgDate.getTime() - lastSession.endTime.getTime() <= this.config.sessionIdleMs) {
      lastSession.endTime = msgDate;
      lastSession.messageCount++;
    } else {
      sessions.push({
        channelName,
        channelId: message.channel.id,
        channelParent,
        startTime: msgDate,
        endTime: msgDate,
        messageCount: 1,
      });
    }
  }

  flushAll(): void {
    for (const [key, state] of this.state) {
      this.flushState(key, state);
    }
  }

  private flushState(key: string, state: UserActivityState): void {
    const logDir = path.join(ACTIVITY_DIR, state.date);
    fs.mkdirSync(logDir, { recursive: true });

    const filename = `${state.userId}-${sanitize(state.username)}.log`;
    const logPath = path.join(logDir, filename);

    const content = this.config.advancedMode
      ? this.buildAdvancedLog(state)
      : this.buildSimpleLog(state);

    fs.writeFileSync(logPath, content, 'utf-8');
  }

  private totalMedia(breakdown: MediaBreakdown): number {
    return (
      breakdown.attachments.images + breakdown.attachments.videos + breakdown.attachments.audio + breakdown.attachments.other +
      breakdown.embedImages.images + breakdown.embedImages.videos + breakdown.embedImages.audio + breakdown.embedImages.other +
      breakdown.embedVideos.images + breakdown.embedVideos.videos + breakdown.embedVideos.audio + breakdown.embedVideos.other +
      breakdown.embedThumbnails.images + breakdown.embedThumbnails.videos + breakdown.embedThumbnails.audio + breakdown.embedThumbnails.other
    );
  }

  private buildMediaTable(breakdown: MediaBreakdown): string {
    const rows: string[] = [];
    const categories: [string, MediaStats][] = [
      ['Images', breakdown.attachments],
      ['Videos', breakdown.embedImages],
      ['Audio', breakdown.embedVideos],
      ['Other', breakdown.embedThumbnails],
    ];

    rows.push('| Category | Attachments | Embed Images | Embed Videos | Thumbnails |');
    rows.push('|----------|-------------|--------------|--------------|------------|');

    const data: [string, MediaStats, MediaStats, MediaStats, MediaStats][] = [
      ['Images', breakdown.attachments, breakdown.embedImages, breakdown.embedVideos, breakdown.embedThumbnails],
      ['Videos', breakdown.attachments, breakdown.embedImages, breakdown.embedVideos, breakdown.embedThumbnails],
      ['Audio', breakdown.attachments, breakdown.embedImages, breakdown.embedVideos, breakdown.embedThumbnails],
      ['Other', breakdown.attachments, breakdown.embedImages, breakdown.embedVideos, breakdown.embedThumbnails],
    ];

    const catNames: [string, keyof MediaStats][] = [
      ['Images', 'images'],
      ['Videos', 'videos'],
      ['Audio', 'audio'],
      ['Other', 'other'],
    ];

    for (const [catName, statKey] of catNames) {
      const attachments = breakdown.attachments[statKey];
      const embedImages = breakdown.embedImages[statKey];
      const embedVideos = breakdown.embedVideos[statKey];
      const thumbnails = breakdown.embedThumbnails[statKey];
      rows.push(`| ${catName.padEnd(8)} | ${String(attachments).padStart(11)} | ${String(embedImages).padStart(12)} | ${String(embedVideos).padStart(12)} | ${String(thumbnails).padStart(10)} |`);
    }

    return rows.join('\n');
  }

  private buildSimpleLog(state: UserActivityState): string {
    const lines: string[] = [];
    const totalMediaCount = this.totalMedia(state.mediaCounts);

    const nameLabel = state.serverName === state.globalName
      ? state.serverName
      : `${state.serverName} (${state.globalName})`;

    lines.push(`# [Simple] Activity Log — ${nameLabel}`);
    lines.push(`# Guild: ${state.guildName}`);
    lines.push(`# Username: @${state.username}`);
    lines.push(`Date: ${state.date}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- Total messages: ${state.messageCount}`);
    lines.push(`- Media sent: ${totalMediaCount}`);
    lines.push('');
    lines.push('### Media Breakdown');
    lines.push(this.buildMediaTable(state.mediaCounts));
    lines.push('');
    lines.push('## Message Timestamps');

    for (const ts of state.timestamps) {
      lines.push(`- ${formatTime(ts)}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private buildAdvancedLog(state: UserActivityState): string {
    const lines: string[] = [];
    const totalMediaCount = this.totalMedia(state.mediaCounts);

    const nameLabel = state.serverName === state.globalName
      ? state.serverName
      : `${state.serverName} (${state.globalName})`;

    lines.push(`# [Advanced] Activity Log — ${nameLabel}`);
    lines.push(`# Guild: ${state.guildName}`);
    lines.push(`# Username: @${state.username}`);
    lines.push(`Date: ${state.date}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- Total messages: ${state.messageCount}`);
    lines.push(`- Media sent: ${totalMediaCount}`);
    lines.push(`- Active sessions: ${state.sessions.length}`);
    lines.push('');
    lines.push('### Media Breakdown');
    lines.push(this.buildMediaTable(state.mediaCounts));
    lines.push('');

    if (state.sessions.length > 0) {
      lines.push('## Sessions');
      for (let i = 0; i < state.sessions.length; i++) {
        const s = state.sessions[i];
        const channelLabel = s.channelParent ? `#${s.channelName} (in ${s.channelParent})` : `#${s.channelName}`;
        lines.push(`### Session ${i + 1} — ${channelLabel} (${formatTime(s.startTime)} – ${formatTime(s.endTime)}, ${s.messageCount} messages)`);
      }
      lines.push('');
    }

    lines.push('## Message Timestamps');
    for (let i = 0; i < state.timestamps.length; i++) {
      const ts = state.timestamps[i];
      const session = this.findSessionForTimestamp(ts, state);
      const channelLabel = session ? `#${session.channelName}` : '';
      lines.push(`- [${formatTime(ts)}] ${channelLabel}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private findSessionForTimestamp(ts: Date, state: UserActivityState): ChatSession | undefined {
    for (const session of state.sessions) {
      if (ts >= session.startTime && ts <= session.endTime) {
        return session;
      }
    }
    return state.sessions[state.sessions.length - 1];
  }
}
