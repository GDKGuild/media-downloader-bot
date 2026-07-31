import React, { useState } from 'react';

interface UserScoreCardProps {
  username: string;
  serverName: string;
  globalName: string;
  guildName: string;
  score: number;
  totalMessages: number;
  totalMedia: number;
  activeDays: number;
  channels: { name: string; messages: number }[];
  rank: number;
  onClick?: () => void;
}

export function UserScoreCard({
  username,
  serverName,
  globalName,
  guildName,
  score,
  totalMessages,
  totalMedia,
  activeDays,
  channels,
  rank,
  onClick,
}: UserScoreCardProps) {
  const [hovered, setHovered] = useState(false);
  const barColor = score >= 80 ? '#22c55e' : score >= 50 ? '#eab308' : score >= 20 ? '#f97316' : '#ef4444';

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={onClick ? 'View latest log' : undefined}
      style={{
        background: '#1a1a1a',
        borderRadius: 8,
        border: `1px solid ${hovered ? '#5865f2' : '#333'}`,
        padding: 16,
        marginBottom: 12,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: rank <= 3 ? '#5865f2' : '#333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 600,
          color: '#fff',
          flexShrink: 0,
        }}>
          {rank}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: '#e0e0e0' }}>
            {serverName === globalName ? serverName : `${serverName} (${globalName})`}
          </div>
          <div style={{ fontSize: 12, color: '#888' }}>
            @{username} &middot; {guildName || 'DM'} &middot; {totalMessages} messages &middot; {totalMedia} media
            {activeDays > 1 && ` \u00b7 ${activeDays} days`}
          </div>
        </div>
        <div style={{
          fontSize: 22,
          fontWeight: 700,
          color: barColor,
          minWidth: 48,
          textAlign: 'right',
        }}>
          {score}
        </div>
        {onClick && (
          <div style={{
            fontSize: 12,
            color: '#7c9fff',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}>
            Log
            <span style={{ fontSize: 14 }}>↗</span>
          </div>
        )}
      </div>

      <div style={{
        height: 8,
        background: '#2a2a2a',
        borderRadius: 4,
        overflow: 'hidden',
        marginBottom: 12,
      }}>
        <div style={{
          height: '100%',
          width: `${score}%`,
          background: barColor,
          borderRadius: 4,
          transition: 'width 0.5s ease',
        }} />
      </div>

      {channels.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            Most active channels
          </div>
          {channels.slice(0, 5).map((ch, i) => {
            const pct = totalMessages > 0 ? Math.round((ch.messages / totalMessages) * 100) : 0;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: `hsl(${210 - i * 30}, 70%, 55%)`,
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 12, color: '#aaa', flex: 1 }}>#{ch.name}</span>
                <span style={{ fontSize: 12, color: '#666' }}>{ch.messages}</span>
                <div style={{
                  width: 60,
                  height: 4,
                  background: '#2a2a2a',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${pct}%`,
                    background: '#5865f2',
                    borderRadius: 2,
                  }} />
                </div>
                <span style={{ fontSize: 11, color: '#555', width: 32, textAlign: 'right' }}>{pct}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
