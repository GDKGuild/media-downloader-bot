import axios from 'axios';

const PIXIV_OAUTH_URL = 'https://oauth.secure.pixiv.net/auth/token';
const PIXIV_API_BASE = 'https://app-api.pixiv.net';
const PIXIV_CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const PIXIV_CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const PIXIV_UA = 'PixivIOSApp/7.16.8 (iOS 16.4.1; iPhone14,3)';

export interface PixivUserInfo {
  userId: string;
  name: string;
}

export interface PixivIllust {
  id: string;
  createDate: string;
}

export interface PixivIllustOwner {
  userId: string;
  userName: string;
}

let accessToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const refreshToken = process.env.PIXIV_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('PIXIV_REFRESH_TOKEN is not set in .env');
  const params = new URLSearchParams({
    client_id: PIXIV_CLIENT_ID,
    client_secret: PIXIV_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await axios.post(PIXIV_OAUTH_URL, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': PIXIV_UA,
    },
    timeout: 20000,
  });
  const data = res.data as { access_token?: string; expires_in?: number; has_error?: boolean };
  if (data.has_error || !data.access_token) throw new Error('Pixiv OAuth refresh failed');
  accessToken = data.access_token;
  const ttlSec = data.expires_in && Number.isFinite(data.expires_in) ? data.expires_in : 3600;
  tokenExpiresAt = Date.now() + ttlSec * 1000 - 60_000;
  return accessToken;
}

async function apiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await getAccessToken();
  const res = await axios.get(`${PIXIV_API_BASE}${path}`, {
    params,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${token}`,
      'App-OS': 'ios',
      'App-Version': '7.16.8',
      'User-Agent': PIXIV_UA,
    },
    validateStatus: (s) => s >= 200 && s < 500,
  });
  const data = res.data as { error?: boolean; message?: string };
  if (data.error) {
    throw new Error(`Pixiv API error: ${data.message ?? 'unknown'} (HTTP ${res.status})`);
  }
  return res.data as T;
}

export function parsePixivUserId(raw: string): string | null {
  const m = raw.trim().match(/(?:pixiv|phixiv)\.net\/(?:[a-z]{2}\/)?users\/(\d+)|user\.php\?id=(\d+)|^(\d+)$/i);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

export function parsePixivArtworkId(raw: string): string | null {
  const m = raw.match(/(?:pixiv|phixiv)\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i);
  return m ? m[1] : null;
}

export async function resolvePixivUser(idOrUrl: string): Promise<PixivUserInfo | null> {
  const id = parsePixivUserId(idOrUrl);
  if (!id) return null;
  const data = await apiGet<{ user?: { id?: number; name?: string } }>('/v1/user/detail', { user_id: id });
  if (!data.user?.id || !data.user.name) return null;
  return { userId: String(data.user.id), name: data.user.name };
}

export async function fetchLatestIllusts(userId: string): Promise<PixivIllust[]> {
  const data = await apiGet<{ illusts?: { id?: number; create_date?: string }[] }>('/v1/user/illusts', { user_id: userId });
  return (data.illusts ?? [])
    .filter((i) => i.id != null)
    .map((i) => ({ id: String(i.id), createDate: i.create_date ?? '' }));
}

export async function fetchIllustOwner(illustId: string): Promise<PixivIllustOwner | null> {
  const data = await apiGet<{ illust?: { user?: { id?: number; name?: string } } }>('/v1/illust/detail', { illust_id: illustId });
  const u = data.illust?.user;
  if (!u?.id || !u.name) return null;
  return { userId: String(u.id), userName: u.name };
}