import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { LogContent } from './components/LogContent';
import { SearchBar } from './components/SearchBar';
import { AnalyticsView } from './components/AnalyticsView';
import { fetchAllUsers, fetchLogContent } from './hooks/useLogs';

type Tab = 'browse' | 'analytics';

export function App() {
  const [tab, setTab] = useState<Tab>('browse');
  const [users, setUsers] = useState<{ date: string; filename: string; userId: string; username: string; serverName: string; globalName: string; guildName: string; mode: string; size: number }[]>([]);
  const [openDates, setOpenDates] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState<{ filename: string; date: string } | null>(null);
  const [logContent, setLogContent] = useState<{ content: string; username: string; serverName: string; globalName: string; guildName: string; mode: string; date: string } | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<'all' | 'Simple' | 'Advanced'>('all');

  useEffect(() => {
    fetchAllUsers().then(setUsers);
  }, []);

  const dates = [...new Set(users.map(u => u.date))].sort((a, b) => b.localeCompare(a));

  const handleSelectDate = useCallback((date: string) => {
    setOpenDates(prev => prev.includes(date) ? prev.filter(d => d !== date) : [...prev, date]);
    setSelectedUser(null);
    setLogContent(null);
  }, []);

  const handleSelectUser = useCallback(async (filename: string, date: string) => {
    setSelectedUser({ filename, date });
    setLogContent(null);
    setLoadingLog(true);
    try {
      const data = await fetchLogContent(date, filename);
      setLogContent({ content: data.content, username: data.username, serverName: data.serverName, globalName: data.globalName, guildName: data.guildName, mode: data.mode, date: data.date });
    } finally {
      setLoadingLog(false);
    }
  }, []);

  const handleOpenUserFromAnalytics = useCallback((username: string) => {
    setTab('browse');
    setSearchQuery(username);
    const latest = users
      .filter(u => u.username === username)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (latest) {
      handleSelectUser(latest.filename, latest.date);
    } else {
      setSelectedUser(null);
      setLogContent(null);
    }
  }, [users, handleSelectUser]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <SearchBar value={searchQuery} onChange={setSearchQuery} />

      <div style={{ display: 'flex', borderBottom: '1px solid #333', background: '#161616' }}>
        <div style={{ display: 'flex', gap: 0, flex: 1 }}>
          {(['browse', 'analytics'] as const).map(t => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setSearchQuery('');
              }}
              style={{
                padding: '10px 20px',
                border: 'none',
                background: 'transparent',
                color: tab === t ? '#fff' : '#666',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: tab === t ? 600 : 400,
                borderBottom: tab === t ? '2px solid #5865f2' : '2px solid transparent',
                textTransform: 'capitalize',
              }}
            >
              {t === 'browse' ? 'Browse Logs' : 'Analytics'}
            </button>
          ))}
        </div>
        <button
          onClick={() => fetch('/api/shutdown', { method: 'POST' })}
          title="Shutdown"
          style={{
            padding: '10px 16px',
            border: 'none',
            background: 'transparent',
            color: '#ef4444',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 2.38a9 9 0 1 0 6 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
        </button>
      </div>

      {tab === 'browse' ? (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <Sidebar
            dates={dates}
            users={users}
            openDates={openDates}
            selectedUser={selectedUser}
            onSelectDate={handleSelectDate}
            onSelectUser={handleSelectUser}
            modeFilter={modeFilter}
            onModeFilterChange={setModeFilter}
            searchQuery={searchQuery}
          />
          <div style={{ flex: 1, overflow: 'auto', background: '#111' }}>
            {loadingLog && (
              <div style={{ padding: 24, color: '#666' }}>Loading...</div>
            )}
            {!loadingLog && logContent && (
              <LogContent
                content={logContent.content}
                username={logContent.username}
                serverName={logContent.serverName}
                globalName={logContent.globalName}
                guildName={logContent.guildName}
                mode={logContent.mode}
                date={logContent.date}
                displayMode={modeFilter}
              />
            )}
            {!loadingLog && !logContent && (
              <div style={{
                padding: 48,
                textAlign: 'center',
                color: '#555',
                fontSize: 14,
              }}>
                Select a date and user to view logs
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <AnalyticsView searchQuery={searchQuery} onOpenUser={handleOpenUserFromAnalytics} />
        </div>
      )}
    </div>
  );
}
