import React, { useState } from 'react';
import { formatBytes } from '../hooks/useMedia';
import type { GuildInfo } from '../types';

interface SidebarProps {
  guilds: GuildInfo[];
  openGuilds: string[];
  selectedPath: string | null;
  loadedCounts: Record<string, { fileCount: number; totalSize: number }>;
  onToggleGuild: (name: string) => void;
  onSelectPath: (path: string) => void;
}

export function Sidebar({ guilds, openGuilds, selectedPath, loadedCounts, onToggleGuild, onSelectPath }: SidebarProps) {
  const [openChannels, setOpenChannels] = useState<string[]>([]);

  const toggleChannel = (path: string) => {
    setOpenChannels(prev => prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]);
  };

  return (
    <div style={{
      width: 260,
      borderRight: '1px solid #2a2a2a',
      background: '#161616',
      overflow: 'auto',
      flexShrink: 0,
    }}>
      {guilds.map(g => (
        <div key={g.name}>
          <div
            onClick={() => onToggleGuild(g.name)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              color: '#ccc',
              background: '#1c1c1c',
              borderBottom: '1px solid #2a2a2a',
              userSelect: 'none',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-block',
                transition: 'transform 0.15s',
                transform: openGuilds.includes(g.name) ? 'rotate(90deg)' : 'none',
                fontSize: 10,
                color: '#666',
              }}>▶</span>
              {g.name}
            </span>
            <span style={{ fontSize: 11, color: '#666' }}>
              {Object.keys(loadedCounts).filter(k => k.startsWith(`${g.name}/`)).reduce((s, k) => s + (loadedCounts[k]?.fileCount || 0), 0) || ''}
            </span>
          </div>

          {openGuilds.includes(g.name) && (
            <div>
              {g.channels.map(ch => {
                const channelPath = `${g.name}/${ch.name}`;
                const selected = selectedPath === channelPath;
                const count = loadedCounts[channelPath];
                const hasThreads = ch.threads && ch.threads.length > 0;
                const open = openChannels.includes(channelPath);
                return (
                  <div key={ch.name}>
                    <div
                      onClick={() => onSelectPath(channelPath)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '7px 12px 7px 28px',
                        cursor: 'pointer',
                        fontSize: 12.5,
                        color: selected ? '#fff' : '#999',
                        background: selected ? '#2b2d31' : 'transparent',
                        borderLeft: selected ? '2px solid #5865f2' : '2px solid transparent',
                        userSelect: 'none',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
                        {hasThreads ? (
                          <span
                            onClick={e => { e.stopPropagation(); toggleChannel(channelPath); }}
                            title={open ? 'Collapse threads' : 'Expand threads'}
                            style={{
                              display: 'inline-block',
                              transition: 'transform 0.15s',
                              transform: open ? 'rotate(90deg)' : 'none',
                              fontSize: 10,
                              color: '#666',
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >▶</span>
                        ) : (
                          <span style={{ width: 10, flexShrink: 0 }} />
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.name}</span>
                      </span>
                      <span style={{ fontSize: 11, color: '#666', flexShrink: 0, marginLeft: 8 }}>
                        {count ? `${count.fileCount} · ${formatBytes(count.totalSize)}` : ''}
                      </span>
                    </div>

                    {open && hasThreads && (
                      <div>
                        {ch.threads!.map(t => {
                          const threadPath = `${channelPath}/${t.name}`;
                          const tSelected = selectedPath === threadPath;
                          const tCount = loadedCounts[threadPath];
                          return (
                            <div
                              key={t.name}
                              onClick={() => onSelectPath(threadPath)}
                              title={t.name}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '6px 12px 6px 56px',
                                cursor: 'pointer',
                                fontSize: 12,
                                color: tSelected ? '#fff' : '#777',
                                background: tSelected ? '#2b2d31' : 'transparent',
                                borderLeft: tSelected ? '2px solid #5865f2' : '2px solid transparent',
                                userSelect: 'none',
                              }}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                              <span style={{ fontSize: 11, color: '#666', flexShrink: 0, marginLeft: 8 }}>
                                {tCount ? `${tCount.fileCount} · ${formatBytes(tCount.totalSize)}` : ''}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {guilds.length === 0 && (
        <div style={{ padding: 24, fontSize: 12, color: '#555', textAlign: 'center' }}>
          No downloaded media found
        </div>
      )}
    </div>
  );
}
