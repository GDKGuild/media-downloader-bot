const API = '/api';

export interface LogUser {
  date: string;
  filename: string;
  userId: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  mode: string;
  size: number;
}

export async function fetchAllUsers(): Promise<LogUser[]> {
  const r = await fetch(`${API}/users`);
  const data = await r.json();
  return data.users;
}

export async function fetchLogContent(date: string, filename: string): Promise<{ date: string; filename: string; userId: string; username: string; serverName: string; globalName: string; guildName: string; mode: string; content: string }> {
  const r = await fetch(`${API}/logs/${encodeURIComponent(date)}/${encodeURIComponent(filename)}`);
  return r.json();
}
