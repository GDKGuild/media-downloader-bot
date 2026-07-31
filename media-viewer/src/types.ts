export type MediaType = 'image' | 'video' | 'audio' | 'other';

export interface ThreadInfo {
  name: string;
}

export interface ChannelInfo {
  name: string;
  threads: ThreadInfo[];
}

export interface GuildInfo {
  name: string;
  channels: ChannelInfo[];
}

export interface FileEntry {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
  mediaType: MediaType;
  category: string;
}
