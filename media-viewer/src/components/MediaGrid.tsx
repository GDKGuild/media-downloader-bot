import React from 'react';
import { mediaUrl, formatBytes } from '../hooks/useMedia';
import type { FileEntry } from '../types';

interface MediaGridProps {
  files: FileEntry[];
  onOpen: (file: FileEntry) => void;
}

export function MediaGrid({ files, onOpen }: MediaGridProps) {
  if (files.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#555', fontSize: 14 }}>
        No files match current filters
      </div>
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      gap: 12,
      padding: 4,
    }}>
      {files.map(f => (
        <div
          key={f.relPath}
          onClick={() => onOpen(f)}
          style={{
            background: '#1a1a1a',
            borderRadius: 8,
            overflow: 'hidden',
            cursor: 'pointer',
            border: '1px solid #2a2a2a',
            transition: 'border-color 0.15s',
            display: 'flex',
            flexDirection: 'column',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = '#5865f2')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2a2a')}
        >
          <div style={{
            height: 140,
            background: '#000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {f.mediaType === 'image' && (
              <img
                src={mediaUrl(f.relPath)}
                alt={f.name}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            )}
            {f.mediaType === 'video' && (
              <video
                src={mediaUrl(f.relPath)}
                muted
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            )}
            {(f.mediaType === 'audio' || f.mediaType === 'other') && (
              <div style={{ fontSize: 40, color: '#444' }}>
                {f.mediaType === 'audio' ? '♪' : '📄'}
              </div>
            )}
          </div>
          <div style={{ padding: 8 }}>
            <div style={{
              fontSize: 12,
              color: '#ccc',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }} title={f.name}>
              {f.name}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666', marginTop: 2 }}>
              <span>{formatBytes(f.size)}</span>
              <span style={{ textTransform: 'capitalize' }}>{f.category}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
