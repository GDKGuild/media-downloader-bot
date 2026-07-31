import React, { useEffect, useRef, useState } from 'react';
import { mediaUrl, formatBytes } from '../hooks/useMedia';
import type { FileEntry } from '../types';

interface MediaPreviewProps {
  file: FileEntry;
  position: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function MediaPreview({ file, position, total, onPrev, onNext, onClose }: MediaPreviewProps) {
  const [zoomLevel, setZoomLevel] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const zoomed = zoomLevel > 1;

  const setZoom = (level: number) => {
    setZoomLevel(level);
    setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onPrev();
      if (e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext, onClose]);

  useEffect(() => {
    setZoom(1);
  }, [file.relPath]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.25 : -0.25;
      const next = Math.min(8, Math.max(1, Math.round((zoomLevel + step) * 10) / 10));
      if (next <= 1) {
        setZoomLevel(1);
        setOffset({ x: 0, y: 0 });
      } else {
        setZoomLevel(next);
      }
    };
    img.addEventListener('wheel', onWheel, { passive: false });
    return () => img.removeEventListener('wheel', onWheel);
  }, [zoomLevel]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!zoomed) return;
    e.preventDefault();
    setDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setOffset({
        x: dragRef.current.baseX + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.baseY + (ev.clientY - dragRef.current.startY),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const url = mediaUrl(file.relPath);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.9)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8, zIndex: 2 }}>
        <a
          href={url}
          download={file.name}
          title="Download"
          style={{
            width: 36,
            height: 36,
            borderRadius: 6,
            background: '#333',
            color: '#ddd',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
        <button
          onClick={onClose}
          title="Close"
          style={{
            width: 36,
            height: 36,
            borderRadius: 6,
            background: '#333',
            color: '#ddd',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 24px 0',
          overflow: 'auto',
        }}
      >
        {file.mediaType === 'image' && (
          <img
            ref={imgRef}
            src={url}
            alt={file.name}
            draggable={false}
            onMouseDown={onMouseDown}
            onDoubleClick={() => setZoom(zoomed ? 1 : 2)}
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: '95vw',
              maxHeight: '100%',
              objectFit: 'contain',
              cursor: zoomed ? 'grab' : 'zoom-in',
              transform: zoomed ? `translate(${offset.x}px, ${offset.y}px) scale(${zoomLevel})` : 'none',
              transformOrigin: 'center center',
              transition: dragging ? 'none' : 'transform 0.1s ease-out',
              userSelect: 'none',
            }}
          />
        )}
        {file.mediaType === 'video' && (
          <video
            src={url}
            controls
            autoPlay
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '95vw', maxHeight: '100%' }}
          />
        )}
        {file.mediaType === 'audio' && (
          <audio src={url} controls autoPlay onClick={e => e.stopPropagation()} style={{ width: 'min(600px, 90vw)' }} />
        )}
        {file.mediaType === 'other' && (
          <div onClick={e => e.stopPropagation()} style={{ fontSize: 64, color: '#555' }}>📄</div>
        )}
      </div>

      <div
        onClick={e => e.stopPropagation()}
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          padding: '16px 24px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: '95vw' }}>
          <span style={{ fontSize: 13, color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.relPath}>
            {file.relPath}
          </span>
          <span style={{ fontSize: 12, color: '#666', flexShrink: 0 }}>{formatBytes(file.size)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onPrev}
            disabled={total <= 1}
            title="Previous"
            style={{
              flexShrink: 0,
              width: 34,
              height: 34,
              borderRadius: 6,
              background: '#333',
              color: '#ddd',
              border: 'none',
              cursor: total <= 1 ? 'default' : 'pointer',
              fontSize: 14,
              opacity: total <= 1 ? 0.4 : 1,
            }}
          >
            ◀
          </button>
          <span style={{ fontSize: 12, color: '#666', flexShrink: 0, minWidth: 48, textAlign: 'center' }}>{position} / {total}</span>
          <button
            onClick={onNext}
            disabled={total <= 1}
            title="Next"
            style={{
              flexShrink: 0,
              width: 34,
              height: 34,
              borderRadius: 6,
              background: '#333',
              color: '#ddd',
              border: 'none',
              cursor: total <= 1 ? 'default' : 'pointer',
              fontSize: 14,
              opacity: total <= 1 ? 0.4 : 1,
            }}
          >
            ▶
          </button>
        </div>
      </div>
    </div>
  );
}
