export interface ActivityConfig {
  advancedMode: boolean;
  sessionIdleMs: number;
}

export interface MediaStats {
  images: number;
  videos: number;
  audio: number;
  other: number;
}

export interface MediaBreakdown {
  attachments: MediaStats;
  embedImages: MediaStats;
  embedVideos: MediaStats;
  embedThumbnails: MediaStats;
}

export interface ChatSession {
  channelName: string;
  channelId: string;
  channelParent?: string;
  startTime: Date;
  endTime: Date;
  messageCount: number;
}

export interface UserActivityState {
  userId: string;
  username: string;
  globalName: string;
  serverName: string;
  guildName: string;
  guildId: string;
  date: string;
  messageCount: number;
  timestamps: Date[];
  mediaCounts: MediaBreakdown;
  sessions: ChatSession[];
}

export function createEmptyMediaStats(): MediaStats {
  return { images: 0, videos: 0, audio: 0, other: 0 };
}

export function createEmptyMediaBreakdown(): MediaBreakdown {
  return {
    attachments: createEmptyMediaStats(),
    embedImages: createEmptyMediaStats(),
    embedVideos: createEmptyMediaStats(),
    embedThumbnails: createEmptyMediaStats(),
  };
}
