import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { MediaGrid } from './components/MediaGrid';
import { MediaPreview } from './components/MediaPreview';
import { fetchTree, fetchFiles } from './hooks/useMedia';
import type { GuildInfo, FileEntry } from './types';

type SortMode = 'name' | 'size' | 'date';

export function App() {
  const [guilds, setGuilds] = useState<GuildInfo[]>([]);
  const [openGuilds, setOpenGuilds] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadedCounts, setLoadedCounts] = useState<Record<string, { fileCount: number; totalSize: number }>>({});
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const selectedPathRef = useRef<string | null>(null);

  useEffect(() => {
    fetchTree()
      .then(t => setGuilds(t.guilds))
      .catch(() => setGuilds([]));
  }, []);

  const handleSelectPath = (path: string) => {
    selectedPathRef.current = path;
    setSelectedPath(path);
    setLoading(true);
    fetchFiles(path)
      .then(d => {
        if (selectedPathRef.current !== path) return;
        setFiles(d.files);
        const categories = new Set(d.files.map(f => f.category));
        if (categoryFilter && !categories.has(categoryFilter)) setCategoryFilter('');
        setLoadedCounts(c => ({
          ...c,
          [path]: {
            fileCount: d.files.length,
            totalSize: d.files.reduce((sum, f) => sum + f.size, 0),
          },
        }));
      })
      .catch(() => {
        if (selectedPathRef.current === path) setFiles([]);
      })
      .finally(() => {
        if (selectedPathRef.current === path) setLoading(false);
      });
  };

  const handleRefresh = () => {
    if (!selectedPath) return;
    setLoading(true);
    fetchFiles(selectedPath, true)
      .then(d => {
        if (selectedPathRef.current !== selectedPath) return;
        setFiles(d.files);
        setLoadedCounts(c => ({
          ...c,
          [selectedPath]: {
            fileCount: d.files.length,
            totalSize: d.files.reduce((sum, f) => sum + f.size, 0),
          },
        }));
      })
      .catch(() => {})
      .finally(() => {
        if (selectedPathRef.current === selectedPath) setLoading(false);
      });
  };

  const categories = useMemo(() => [...new Set(files.map(f => f.category))].sort(), [files]);

  const visibleFiles = useMemo(() => {
    let list = files;
    if (categoryFilter) list = list.filter(f => f.category === categoryFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(f => f.name.toLowerCase().includes(q) || f.relPath.toLowerCase().includes(q));
    }
    const sorted = [...list];
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortMode === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) * dir);
    if (sortMode === 'size') sorted.sort((a, b) => (a.size - b.size) * dir);
    if (sortMode === 'date') sorted.sort((a, b) => (a.mtime - b.mtime) * dir);
    return sorted;
  }, [files, categoryFilter, searchQuery, sortMode, sortDir]);

  const previewList = useMemo(() => {
    if (!previewFile) return { list: [] as FileEntry[], index: -1, total: 0 };
    const list = visibleFiles.filter(f => f.mediaType === previewFile.mediaType);
    const index = list.findIndex(f => f.relPath === previewFile.relPath);
    return { list, index, total: list.length };
  }, [visibleFiles, previewFile]);

  const handleNav = (dir: 1 | -1) => {
    if (previewList.index === -1 || previewList.total <= 1) return;
    const next = previewList.list[(previewList.index + dir + previewList.total) % previewList.total];
    setPreviewFile(next);
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #333', background: '#161616', padding: '0 16px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e0', flex: 1 }}>
          Media Viewer
          {selectedPath && <span style={{ fontWeight: 400, color: '#666', fontSize: 13 }}> — {selectedPath}</span>}
        </div>
        <button
          onClick={() => fetch('/api/shutdown', { method: 'POST' })}
          title="Shutdown"
          style={{
            padding: '10px 8px',
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

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar
          guilds={guilds}
          openGuilds={openGuilds}
          selectedPath={selectedPath}
          loadedCounts={loadedCounts}
          onToggleGuild={name => setOpenGuilds(prev => prev.includes(name) ? prev.filter(g => g !== name) : [...prev, name])}
          onSelectPath={handleSelectPath}
        />

        <div style={{ flex: 1, overflow: 'auto', background: '#111' }}>
          {!selectedPath && (
            <div style={{ padding: 48, textAlign: 'center', color: '#555', fontSize: 14 }}>
              Select a server and channel to view media
            </div>
          )}

          {selectedPath && (
            <div style={{ padding: 16 }}>
              <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setCategoryFilter('')}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 4,
                      border: 'none',
                      background: categoryFilter === '' ? '#5865f2' : '#1a1a1a',
                      color: categoryFilter === '' ? '#fff' : '#888',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    All
                  </button>
                  {categories.map(c => (
                    <button
                      key={c}
                      onClick={() => setCategoryFilter(c)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 4,
                        border: 'none',
                        background: categoryFilter === c ? '#5865f2' : '#1a1a1a',
                        color: categoryFilter === c ? '#fff' : '#888',
                        cursor: 'pointer',
                        fontSize: 12,
                        textTransform: 'capitalize',
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>

                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search files..."
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #333',
                    background: '#1a1a1a',
                    color: '#e0e0e0',
                    fontSize: 13,
                    outline: 'none',
                    flex: 1,
                    minWidth: 160,
                    maxWidth: 280,
                  }}
                />

                <select
                  value={sortMode}
                  onChange={e => setSortMode(e.target.value as SortMode)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #333',
                    background: '#1a1a1a',
                    color: '#e0e0e0',
                    fontSize: 13,
                    outline: 'none',
                  }}
                >
                  <option value="name">Sort: Name</option>
                  <option value="size">Sort: Size</option>
                  <option value="date">Sort: Date</option>
                </select>

                <button
                  onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                  title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #333',
                    background: sortDir === 'asc' ? '#1a1a1a' : '#2b2d31',
                    color: sortDir === 'asc' ? '#4ade80' : '#f87171',
                    cursor: 'pointer',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
                </button>

                <button
                  onClick={handleRefresh}
                  title="Rescan channel"
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid #333',
                    background: '#1a1a1a',
                    color: '#bbb',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  Refresh
                </button>

                <span style={{ fontSize: 12, color: '#666' }}>
                  {visibleFiles.length} file{visibleFiles.length !== 1 ? 's' : ''}
                </span>
              </div>

              {loading && <div style={{ padding: 24, color: '#666' }}>Loading...</div>}

              {!loading && (
                <MediaGrid files={visibleFiles} onOpen={setPreviewFile} />
              )}
            </div>
          )}
        </div>
      </div>

      {previewFile && (
        <MediaPreview
          file={previewFile}
          position={previewList.index + 1}
          total={previewList.total}
          onPrev={() => handleNav(-1)}
          onNext={() => handleNav(1)}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
