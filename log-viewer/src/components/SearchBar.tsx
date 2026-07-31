import React from 'react';

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
}

export function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: '1px solid #333',
      background: '#1a1a1a',
    }}>
      <input
        type="text"
        placeholder="Search users..."
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 12px',
          borderRadius: 6,
          border: '1px solid #444',
          background: '#222',
          color: '#e0e0e0',
          fontSize: 14,
          outline: 'none',
        }}
      />
    </div>
  );
}
