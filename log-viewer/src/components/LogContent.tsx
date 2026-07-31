import React from 'react';

interface LogContentProps {
  content: string;
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  mode: string;
  date: string;
  displayMode: 'all' | 'Simple' | 'Advanced';
}

function isAdvancedOnly(line: string, inSessions: boolean): boolean {
  if (line.startsWith('- Active sessions:')) return true;
  if (line.trim() === '## Sessions') return true;
  if (inSessions && line.startsWith('### ')) return true;
  if (inSessions && line.trim() === '') return false;
  return false;
}

function stripChannelLabel(line: string): string {
  return line.replace(/^(-\s+)\[[^\]]+\]\s+(.+)/, '$1$2');
}

export function LogContent({ content, username, serverName, globalName, guildName, mode, date, displayMode }: LogContentProps) {
  const lines = content.split('\n');

  const nameLabel = serverName === globalName
    ? serverName
    : `${serverName} (${globalName})`;

  const filteredLines = displayMode === 'Simple'
    ? lines.filter((_, i, arr) => {
        const prev = i > 0 ? arr[i - 1] : '';
        const inSessions = prev.trim() === '## Sessions' || (i > 1 && arr[i - 2]?.trim() === '## Sessions' && !arr[i - 1].startsWith('## ') && !arr[i - 1].startsWith('# '));
        return !isAdvancedOnly(arr[i], inSessions);
      })
    : lines;

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      <div style={{
        marginBottom: 16,
        padding: '8px 12px',
        borderRadius: 6,
        background: mode === 'Advanced' ? '#2e1065' : '#1e293b',
        display: 'inline-block',
        fontSize: 12,
        color: '#94a3b8',
      }}>
        {nameLabel} <span style={{ color: '#666' }}>@{username}</span> &middot; {guildName || 'DM'} &middot; {date} &middot; {mode}
        {displayMode === 'Simple' && <span style={{ marginLeft: 8, color: '#666' }}>(Simple view)</span>}
      </div>
      <pre style={{
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 13,
        lineHeight: 1.6,
        color: '#d4d4d4',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {filteredLines.map((line, i) => {
          if (line.startsWith('# [')) {
            return (
              <div key={i} style={{
                color: '#e879f9',
                fontWeight: 600,
                fontSize: 15,
                marginTop: i > 1 ? 8 : 0,
              }}>
                {line.replace(/^# /, '')}
              </div>
            );
          }
          if (line.startsWith('## ')) {
            return (
              <div key={i} style={{
                color: '#fbbf24',
                fontWeight: 600,
                fontSize: 14,
                marginTop: 12,
                marginBottom: 4,
              }}>
                {line.replace(/^## /, '')}
              </div>
            );
          }
          if (line.startsWith('### ')) {
            return (
              <div key={i} style={{
                color: '#67e8f9',
                fontWeight: 500,
                fontSize: 13,
                marginTop: 8,
              }}>
                {line.replace(/^### /, '')}
              </div>
            );
          }
          if (line.startsWith('|')) {
            const isHeader = filteredLines[i - 1]?.startsWith('|');
            return (
              <div key={i} style={{ color: isHeader ? '#a78bfa' : '#94a3b8' }}>
                {line}
              </div>
            );
          }
          if (line.startsWith('- ')) {
            const displayLine = displayMode === 'Simple' ? stripChannelLabel(line) : line;
            return (
              <div key={i} style={{ color: '#9ca3af', paddingLeft: 12 }}>
                {displayLine}
              </div>
            );
          }
          if (line.startsWith('Date:')) {
            return (
              <div key={i} style={{ color: '#6b7280', marginBottom: 8 }}>
                {line}
              </div>
            );
          }
          return <div key={i} style={{ color: '#a1a1aa' }}>{line}</div>;
        })}
      </pre>
    </div>
  );
}
