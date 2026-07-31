import type { GuildInfo, FileEntry } from '../types';

export async function fetchTree(): Promise<{ root: string; guilds: GuildInfo[] }> {
  const r = await fetch('/api/tree');
  if (!r.ok) throw new Error(`Tree request failed: ${r.status}`);
  return r.json();
}

export async function fetchFiles(dir: string, refresh = false): Promise<{ dir: string; files: FileEntry[] }> {
  const r = await fetch(`/api/files?dir=${encodeURIComponent(dir)}${refresh ? '&refresh=1' : ''}`);
  if (!r.ok) throw new Error(`Files request failed: ${r.status}`);
  return r.json();
}

export function mediaUrl(relPath: string): string {
  return `/api/media/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
