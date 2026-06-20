import { Message, Embed } from 'discord.js';
import { MediaConfig } from '../types';

export type MediaCategory = 'images' | 'videos' | 'audio' | 'other';

export interface MediaEntry {
  url: string;
  proxyUrl: string | null;
  index: number;
  filename: string;
  category: MediaCategory;
  type: 'attachment' | 'embed-image' | 'embed-video' | 'embed-thumbnail';
  ext: string;
  timestamp?: number;
}

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
export const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv'];
export const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function categorizeAttachment(filename: string): MediaCategory {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'images';
  if (VIDEO_EXTS.includes(ext)) return 'videos';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return 'other';
}

export function shouldDownloadFile(filename: string, mediaConfig?: MediaConfig): boolean {
  if (!mediaConfig) return true;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return mediaConfig.images;
  if (VIDEO_EXTS.includes(ext)) return mediaConfig.videos;
  if (AUDIO_EXTS.includes(ext)) return mediaConfig.audio;
  return mediaConfig.other;
}

export function getExtensionFromMime(mimeType: string): string | null {
  const mimeMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/x-flv': 'flv',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
  };
  return mimeMap[mimeType] || null;
}

export function getExtensionFromFilename(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'bin';
}

export function extractEmojiIds(content: string): string[] {
  const ids = new Set<string>();
  const regex = /<(a)?:(\w+):(\d+)>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[3]);
  }
  return Array.from(ids);
}

export function categorizeMediaType(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'images';
  if (VIDEO_EXTS.includes(ext)) return 'videos';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return 'other';
}

export function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_');
}

function extractExtensionFromUrl(url: string, type: string): string {
  try {
    const parsed = new URL(url);
    const ext = parsed.pathname.split('.').pop()?.toLowerCase() || '';
    if (ext && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'svg', 'bmp', 'ico', 'mov', 'avi', 'mkv', 'flv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return ext;
  } catch {
    // invalid URL, fall through
  }
  if (type === 'embed-video') return 'mp4';
  if (type === 'embed-image' || type === 'embed-thumbnail') return 'png';
  return 'bin';
}

function extractFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const basename = parsed.pathname.split('/').pop() || 'unknown';
    return basename || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function extractMediaFromMessage(msg: Message, index: number, mediaConfig?: MediaConfig): MediaEntry[] {
  const entries: MediaEntry[] = [];

  for (const att of msg.attachments.values()) {
    const name = att.name || 'unknown';
    if (shouldDownloadFile(name, mediaConfig)) {
      entries.push({
        url: att.url,
        proxyUrl: att.proxyURL,
        index,
        filename: name,
        category: categorizeAttachment(name),
        type: 'attachment',
        ext: getExtensionFromFilename(name),
        timestamp: msg.createdTimestamp,
      });
    }
  }

  for (const embed of msg.embeds) {
    const isGifv = embed.data.type === 'gifv';
    const embedCategory: MediaCategory = isGifv ? 'other' : 'images';
    const videoCategory: MediaCategory = isGifv ? 'other' : 'videos';

    if (embed.image?.url) {
      entries.push({
        url: embed.image.url,
        proxyUrl: embed.image.proxyURL ?? null,
        index,
        filename: extractFilenameFromUrl(embed.image.url),
        category: embedCategory,
        type: 'embed-image',
        ext: extractExtensionFromUrl(embed.image.url, 'embed-image'),
        timestamp: msg.createdTimestamp,
      });
    }
    if (embed.video?.url) {
      entries.push({
        url: embed.video.url,
        proxyUrl: embed.video.proxyURL ?? null,
        index,
        filename: extractFilenameFromUrl(embed.video.url),
        category: videoCategory,
        type: 'embed-video',
        ext: extractExtensionFromUrl(embed.video.url, 'embed-video'),
        timestamp: msg.createdTimestamp,
      });
    }
    if (embed.thumbnail?.url && !embed.image?.url && !embed.video?.url) {
      entries.push({
        url: embed.thumbnail.url,
        proxyUrl: embed.thumbnail.proxyURL ?? null,
        index,
        filename: extractFilenameFromUrl(embed.thumbnail.url),
        category: embedCategory,
        type: 'embed-thumbnail',
        ext: extractExtensionFromUrl(embed.thumbnail.url, 'embed-thumbnail'),
        timestamp: msg.createdTimestamp,
      });
    }
  }

  return entries;
}

export function countMedia(messages: Message[], mediaConfig?: MediaConfig): number {
  let count = 0;
  messages.forEach((msg, i) => {
    count += extractMediaFromMessage(msg, i, mediaConfig).length;
  });
  return count;
}
