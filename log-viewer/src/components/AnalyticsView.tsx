import React, { useState, useEffect } from 'react';
import { UserScoreCard } from './UserScoreCard';

interface AnalyticsUser {
  userId: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  score: number;
  totalMessages: number;
  totalMedia: number;
  activeDays: number;
  channels: { name: string; messages: number }[];
}

async function fetchAnalytics(period: string, date: string): Promise<{ period: string; dateRange: string[]; users: AnalyticsUser[] }> {
  const r = await fetch(`/api/analytics?period=${period}&date=${encodeURIComponent(date)}`);
  return r.json();
}

interface AnalyticsViewProps {
  searchQuery: string;
  onOpenUser: (username: string) => void;
}

export function AnalyticsView({ searchQuery, onOpenUser }: AnalyticsViewProps) {
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [data, setData] = useState<{ period: string; users: AnalyticsUser[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState<'messages' | 'media'>('messages');
  const [selectedGuild, setSelectedGuild] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('');

  useEffect(() => {
    fetch('/api/dates')
      .then(r => r.json())
      .then(d => {
        const dates = (d.dates as { date: string }[]).map((x: { date: string }) => x.date);
        setAvailableDates(dates);
        if (dates.length > 0 && !selectedDate) {
          setSelectedDate(dates[0]);
        }
      });
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    setSelectedGuild('');
    setSelectedChannel('');
    fetchAnalytics(period, selectedDate)
      .then(d => setData(d))
      .finally(() => setLoading(false));
  }, [period, selectedDate]);

  const guilds = [...new Set((data?.users || []).map(u => u.guildName).filter(Boolean))].sort();

  const guildFiltered = data?.users.filter(u => !selectedGuild || u.guildName === selectedGuild) || [];

  const channels = [...new Set(guildFiltered.flatMap(u => u.channels.map(c => c.name)))]
    .sort((a, b) => a.localeCompare(b));

  const guildChannelFiltered = guildFiltered.filter(u => !selectedChannel || u.channels.some(c => c.name === selectedChannel));

  const filteredUsers = guildChannelFiltered.filter(u => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return u.username.toLowerCase().includes(q) || u.serverName.toLowerCase().includes(q) || u.globalName.toLowerCase().includes(q) || u.guildName.toLowerCase().includes(q) || u.userId.includes(q);
  }) || [];

  const sorted = [...filteredUsers]
    .sort((a, b) => (sortBy === 'media' ? b.totalMedia - a.totalMedia : b.totalMessages - a.totalMessages));

  const maxVal = sorted.length > 0 ? (sortBy === 'media' ? sorted[0].totalMedia : sorted[0].totalMessages) : 1;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0, borderBottom: '1px solid #222' }}>
        <div style={{ display: 'flex', gap: 4, background: '#1a1a1a', borderRadius: 6, padding: 3 }}>
          {(['day', 'week', 'month'] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: '6px 16px',
                borderRadius: 4,
                border: 'none',
                background: period === p ? '#5865f2' : 'transparent',
                color: period === p ? '#fff' : '#888',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: period === p ? 500 : 400,
              }}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4, background: '#1a1a1a', borderRadius: 6, padding: 3 }}>
          {(['messages', 'media'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              style={{
                padding: '6px 16px',
                borderRadius: 4,
                border: 'none',
                background: sortBy === s ? '#7c3aed' : 'transparent',
                color: sortBy === s ? '#fff' : '#888',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: sortBy === s ? 500 : 400,
              }}
            >
              {s === 'messages' ? 'Most Messages' : 'Most Media'}
            </button>
          ))}
        </div>

        <select
          value={selectedGuild}
          onChange={e => { setSelectedGuild(e.target.value); setSelectedChannel(''); }}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #444',
            background: '#1a1a1a',
            color: '#e0e0e0',
            fontSize: 13,
            outline: 'none',
          }}
        >
          <option value="">All Servers</option>
          {guilds.map(g => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>

        <select
          value={selectedChannel}
          onChange={e => setSelectedChannel(e.target.value)}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #444',
            background: '#1a1a1a',
            color: '#e0e0e0',
            fontSize: 13,
            outline: 'none',
          }}
        >
          <option value="">All Channels</option>
          {channels.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #444',
            background: '#1a1a1a',
            color: '#e0e0e0',
            fontSize: 13,
            outline: 'none',
          }}
        >
          {availableDates.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>

        {data && (
          <span style={{ fontSize: 12, color: '#666' }}>
            {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
            {searchQuery.trim() && ` (filtered)`}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ padding: 32, textAlign: 'center', color: '#666' }}>Loading...</div>
        )}

        {!loading && data && data.users.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: '#555' }}>
            No activity data for this period
          </div>
        )}

        {!loading && data && data.users.length > 0 && sorted.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: '#555' }}>
            No users match current filters
          </div>
        )}

        {!loading && sorted.map((u, i) => (
          <UserScoreCard
            key={u.userId}
            username={u.username}
            serverName={u.serverName}
            globalName={u.globalName}
            guildName={u.guildName}
            score={maxVal > 0 ? Math.round((sortBy === 'media' ? u.totalMedia : u.totalMessages) / maxVal * 100) : 0}
            totalMessages={u.totalMessages}
            totalMedia={u.totalMedia}
            activeDays={u.activeDays}
            channels={u.channels}
            rank={i + 1}
            onClick={() => onOpenUser(u.username)}
          />
        ))}
      </div>
    </div>
  );
}
