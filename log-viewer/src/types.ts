export interface DateEntry {
  date: string;
  userCount: number;
}

export interface UserEntry {
  filename: string;
  userId: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  mode: 'Simple' | 'Advanced';
  size: number;
}

export interface LogContent {
  date: string;
  filename: string;
  userId: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  mode: 'Simple' | 'Advanced';
  content: string;
}

export interface SearchMatch {
  line: string;
  index: number;
}

export interface SearchResult {
  date: string;
  userId: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  filename: string;
  mode: 'Simple' | 'Advanced';
  matchCount: number;
  matches: SearchMatch[];
}
