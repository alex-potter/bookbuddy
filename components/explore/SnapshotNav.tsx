'use client';

import { useState } from 'react';
import type { AnalysisResult, Snapshot, StoredBookState, EbookChapter } from '@/types';
import { normalizeTitle } from '@/lib/normalize-title';

interface SnapshotNavProps {
  snapshots: Snapshot[];
  chapters: EbookChapter[];
  viewingSnapshotIndex: number | null;
  stored: StoredBookState;
  onNavigate: (snapshotIndex: number | null, chapterIndex: number, result: AnalysisResult) => void;
}

export default function SnapshotNav({ snapshots, chapters, viewingSnapshotIndex, stored, onNavigate }: SnapshotNavProps) {
  const [playSpeed, setPlaySpeed] = useState(2000);
  const [playing, setPlaying] = useState(false);

  if (snapshots.length === 0) return null;

  const snaps = [...snapshots].sort((a, b) => a.index - b.index);
  const pos = viewingSnapshotIndex === null
    ? snaps.length - 1
    : snaps.findIndex((s) => s.index === viewingSnapshotIndex);
  const atLatest = viewingSnapshotIndex === null || pos === snaps.length - 1;
  const snap = snaps[pos];
  const chTitle = normalizeTitle(chapters[snap?.index]?.title ?? `Chapter ${(snap?.index ?? 0) + 1}`);

  function goTo(newPos: number) {
    const target = snaps[newPos];
    if (newPos === snaps.length - 1) {
      onNavigate(null, stored.lastAnalyzedIndex, stored.result);
    } else {
      onNavigate(target.index, target.index, target.result);
    }
  }

  return (
    <div className="mx-4 mt-2 flex items-center gap-1 px-2 py-1.5 bg-paper-raised rounded-xl border border-border flex-shrink-0">
      <button
        onClick={() => goTo(Math.max(0, pos - 1))}
        disabled={pos <= 0 || playing}
        className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-base text-ink-soft hover:text-ink hover:bg-paper-dark disabled:opacity-30 disabled:cursor-default transition-colors"
      >&#8249;</button>
      <span className="flex-1 text-center truncate px-1 font-serif text-sm">
        {atLatest
          ? <><span className="font-semibold text-ink">ch.{(snap?.index ?? 0) + 1} — {chTitle}</span> <span className="text-xs text-ink-dim">(latest)</span></>
          : <><span className="text-xs text-ink-dim">Viewing </span><span className="font-semibold text-ink">ch.{snap.index + 1} — {chTitle}</span> <span className="text-xs text-ink-dim">({pos + 1}/{snaps.length})</span></>
        }
      </span>
      <button
        onClick={() => goTo(Math.min(snaps.length - 1, pos + 1))}
        disabled={atLatest || playing}
        className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-base text-ink-soft hover:text-ink hover:bg-paper-dark disabled:opacity-30 disabled:cursor-default transition-colors"
      >&#8250;</button>
      <div className="w-px h-4 bg-border mx-1" />
      <select
        value={playSpeed}
        onChange={(e) => setPlaySpeed(Number(e.target.value))}
        className="text-xs bg-transparent text-ink-dim border-none outline-none cursor-pointer hover:text-ink transition-colors font-mono"
      >
        <option value={3000}>Slow</option>
        <option value={2000}>Normal</option>
        <option value={1000}>Fast</option>
        <option value={400}>Very fast</option>
      </select>
      <button
        onClick={() => {
          if (playing) { setPlaying(false); return; }
          if (atLatest && snaps.length > 1) goTo(0);
          setPlaying(true);
        }}
        className="text-ink-soft hover:text-ink transition-colors w-6 h-6 flex items-center justify-center rounded-md hover:bg-paper-dark"
      >
        {playing
          ? <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><rect x="0" y="0" width="3" height="12"/><rect x="7" y="0" width="3" height="12"/></svg>
          : <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><polygon points="0,0 10,6 0,12"/></svg>
        }
      </button>
    </div>
  );
}
