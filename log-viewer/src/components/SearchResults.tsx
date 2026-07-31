import React from 'react';

interface SearchResultsProps {
  results: {
    date: string;
    userId: string;
    username: string;
    serverName: string;
    globalName: string;
    guildName: string;
    filename: string;
    mode: string;
    matchCount: number;
    matches: { line: string; index: number }[];
  }[];
  query: string;
  onSelect: (date: string, filename: string) => void;
  onClose: () => void;
}

export function SearchResults({ results, query, onSelect, onClose }: SearchResultsProps) {
  return (
    <div style={{
      position: 'absolute',
      top: 54,
      left: 16,
      right: 16,
      maxHeight: '70vh',
      overflow: 'auto',
      background: '#1a1a1a',
      border: '1px solid #444',
      borderRadius: 8,
      zIndex: 100,
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
    }}>
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ fontSize: 13, color: '#888' }}>
          {results.length} result{results.length !== 1 ? 's' : ''} for &quot;{query}&quot;
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            fontSize: 16,
          }}
        >
          &times;
        </button>
      </div>
      {results.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: '#666' }}>No results found</div>
      )}
      {results.map((r, i) => (
        <div
          key={`${r.date}-${r.filename}-${i}`}
          onClick={() => onSelect(r.date, r.filename)}
          style={{
            padding: '10px 16px',
            cursor: 'pointer',
            borderBottom: '1px solid #2a2a2a',
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <div>
              <span style={{ fontSize: 13, color: '#ddd' }}>{r.serverName === r.globalName ? r.serverName : `${r.serverName} (${r.globalName})`}</span>
              <span style={{ fontSize: 11, color: '#666', marginLeft: 4 }}>@{r.username}</span>
            </div>
            <span style={{ fontSize: 11, color: '#666' }}>{r.guildName || 'DM'} &middot; {r.date}</span>
            <span style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 3,
              background: r.mode === 'Advanced' ? '#7c3aed' : '#555',
              color: '#fff',
            }}>
              {r.mode}
            </span>
            <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>
              {r.matchCount} match{r.matchCount !== 1 ? 'es' : ''}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.5 }}>
            {r.matches.slice(0, 3).map((m, j) => (
              <div key={j}>
                <span style={{ color: '#666', marginRight: 8 }}>L{m.index + 1}</span>
                {highlightMatch(m.line, query)}
              </div>
            ))}
            {r.matches.length > 3 && (
              <div style={{ color: '#555', marginTop: 2 }}>...and {r.matches.length - 3} more</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ background: '#854d0e', borderRadius: 2, padding: '0 2px' }}>
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  );
}
