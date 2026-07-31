import React from 'react';
import type { LogUser } from '../hooks/useLogs';

interface SidebarProps {
  dates: string[];
  users: LogUser[];
  openDates: string[];
  selectedUser: { filename: string; date: string } | null;
  onSelectDate: (d: string) => void;
  onSelectUser: (f: string, date: string) => void;
  modeFilter: 'all' | 'Simple' | 'Advanced';
  onModeFilterChange: (m: 'all' | 'Simple' | 'Advanced') => void;
  searchQuery: string;
}

export function Sidebar({
  dates,
  users,
  openDates,
  selectedUser,
  onSelectDate,
  onSelectUser,
  modeFilter,
  onModeFilterChange,
  searchQuery,
}: SidebarProps) {
  const q = searchQuery.trim().toLowerCase();
  const modeOk = (u: LogUser) => modeFilter === 'all' || u.mode === modeFilter;
  const matches = (u: LogUser) => !q
    || u.username.toLowerCase().includes(q)
    || u.userId.includes(q)
    || u.serverName.toLowerCase().includes(q)
    || u.globalName.toLowerCase().includes(q)
    || u.guildName.toLowerCase().includes(q);

  const searching = q.length > 0;
  const searchMatches = users
    .filter(u => matches(u) && modeOk(u))
    .sort((a, b) => b.date.localeCompare(a.date) || a.username.localeCompare(b.username));

  return (
    <div style={{
      width: 300,
      borderRight: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      background: '#161616',
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #333' }}>
        <h2 style={{ fontSize: 16, margin: 0, color: '#ddd' }}>Activity Logs</h2>
      </div>

      <div style={{ padding: '8px 16px', display: 'flex', gap: 4, borderBottom: '1px solid #333' }}>
        {(['all', 'Simple', 'Advanced'] as const).map(m => (
          <button
            key={m}
            onClick={() => onModeFilterChange(m)}
            style={{
              flex: 1,
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #444',
              background: modeFilter === m ? '#5865f2' : '#222',
              color: '#e0e0e0',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {m === 'all' ? 'All' : m}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {searching ? (
          <>
            <div style={{ padding: '8px 16px', color: '#666', fontSize: 12 }}>
              {searchMatches.length} matching log{searchMatches.length !== 1 ? 's' : ''}
            </div>
            {searchMatches.length === 0 && (
              <div style={{ padding: '16px', color: '#666', fontSize: 13 }}>No matching users</div>
            )}
            {searchMatches.map(u => (
              <div
                key={`${u.date}-${u.filename}`}
                onClick={() => onSelectUser(u.filename, u.date)}
                style={{
                  padding: '8px 16px',
                  cursor: 'pointer',
                  background: selectedUser?.filename === u.filename && selectedUser?.date === u.date ? '#2a2a2a' : 'transparent',
                  borderBottom: '1px solid #2a2a2a',
                }}
              >
                <div style={{ fontSize: 11, color: '#666' }}>{u.date}</div>
                <div style={{ fontSize: 13, color: '#e0e0e0' }}>
                  {u.serverName === u.globalName ? u.serverName : `${u.serverName} (${u.globalName})`}
                </div>
                <div style={{ fontSize: 11, color: '#666' }}>
                  @{u.username} | {u.guildName || 'DM'}
                </div>
              </div>
            ))}
          </>
        ) : (
          dates.map(d => {
            const isOpen = openDates.includes(d);
            const dateUsers = users
              .filter(u => u.date === d && modeOk(u))
              .sort((a, b) => a.username.localeCompare(b.username));
            return (
              <div key={d}>
                <div
                  onClick={() => onSelectDate(d)}
                  style={{
                    padding: '8px 16px',
                    cursor: 'pointer',
                    background: isOpen ? '#222' : 'transparent',
                    borderBottom: '1px solid #2a2a2a',
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 13,
                    color: '#aaa',
                  }}
                >
                  <span>{isOpen ? '▼' : '▶'} {d}</span>
                  <span style={{ color: '#888' }}>{dateUsers.length}</span>
                </div>

                {isOpen && (
                  <div style={{ background: '#1e1e1e' }}>
                    {dateUsers.length === 0 && (
                      <div style={{ padding: '8px 16px', color: '#666', fontSize: 13 }}>No logs</div>
                    )}
                    {dateUsers.map(u => (
                      <div
                        key={u.filename}
                        onClick={() => onSelectUser(u.filename, d)}
                        style={{
                          padding: '6px 16px 6px 28px',
                          cursor: 'pointer',
                          background: selectedUser?.filename === u.filename && selectedUser?.date === d ? '#2a2a2a' : 'transparent',
                          fontSize: 13,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div>
                          <div style={{ color: '#e0e0e0', lineHeight: 1.3 }}>
                            {u.serverName === u.globalName ? u.serverName : `${u.serverName} (${u.globalName})`}
                          </div>
                          <div style={{ fontSize: 11, color: '#666' }}>@{u.username} | {u.guildName || 'DM'}</div>
                        </div>
                        <span style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 3,
                          background: u.mode === 'Advanced' ? '#7c3aed' : '#555',
                          color: '#fff',
                        }}>
                          {u.mode}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
