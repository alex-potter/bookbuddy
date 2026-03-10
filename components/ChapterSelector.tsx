'use client';

import { useState } from 'react';
import type { EbookChapter } from '@/types';

interface Props {
  chapters: EbookChapter[];
  currentIndex: number;
  onChange: (index: number) => void;
  onAnalyze: () => void;
  onRebuild: () => void;
  onCancelRebuild: () => void;
  analyzing: boolean;
  rebuilding: boolean;
  rebuildProgress: { current: number; total: number } | null;
  canIncrement: boolean;
  lastAnalyzedIndex: number | null;
  snapshotIndices?: Set<number>;
}

const BYTES_PER_LOCATION = 128;

function locationToChapterIndex(location: number, chapters: EbookChapter[]): number {
  const targetOffset = location * BYTES_PER_LOCATION;
  let cumulative = 0;
  for (let i = 0; i < chapters.length; i++) {
    cumulative += chapters[i].text.length;
    if (cumulative >= targetOffset) return i;
  }
  return chapters.length - 1;
}

function chapterIndexToLocation(index: number, chapters: EbookChapter[]): number {
  let cumulative = 0;
  for (let i = 0; i <= index; i++) cumulative += chapters[i].text.length;
  return Math.round(cumulative / BYTES_PER_LOCATION);
}

export default function ChapterSelector({
  chapters,
  currentIndex,
  onChange,
  onAnalyze,
  onRebuild,
  onCancelRebuild,
  analyzing,
  rebuilding,
  rebuildProgress,
  canIncrement,
  lastAnalyzedIndex,
  snapshotIndices,
}: Props) {
  const [mode, setMode] = useState<'chapter' | 'location'>('chapter');
  const [locationInput, setLocationInput] = useState('');

  const totalLocations = chapterIndexToLocation(chapters.length - 1, chapters);
  const busy = analyzing || rebuilding;

  function handleLocationChange(raw: string) {
    setLocationInput(raw);
    const loc = parseInt(raw, 10);
    if (!isNaN(loc) && loc > 0) onChange(locationToChapterIndex(loc, chapters));
  }

  function handleModeSwitch(next: 'chapter' | 'location') {
    setMode(next);
    if (next === 'location') setLocationInput(String(chapterIndexToLocation(currentIndex, chapters)));
  }

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-zinc-700 mb-4">
        {(['chapter', 'location'] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeSwitch(m)}
            className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
              mode === m
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {m === 'chapter' ? 'By Chapter' : 'Kindle Location'}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
          Currently at
        </label>

        {mode === 'chapter' ? (
          <>
            <div className="relative">
              <select
                value={currentIndex}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full appearance-none bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 pr-8 text-zinc-200 text-sm focus:outline-none focus:border-zinc-500 cursor-pointer"
              >
                {chapters.map((ch, i) => (
                  <option key={ch.id} value={i}>{i + 1}. {ch.title}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-zinc-500">
                ▾
              </div>
            </div>
            <p className="mt-1.5 text-xs text-zinc-600">
              {currentIndex + 1} of {chapters.length} chapters
            </p>
          </>
        ) : (
          <>
            <input
              type="number"
              min={1}
              max={totalLocations}
              value={locationInput}
              onChange={(e) => handleLocationChange(e.target.value)}
              placeholder="e.g. 3421"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-zinc-200 text-sm focus:outline-none focus:border-zinc-500"
            />
            <p className="mt-1.5 text-xs text-zinc-600">
              ≈ {chapters[currentIndex]?.title} · ~{totalLocations.toLocaleString()} total
            </p>
            <p className="mt-0.5 text-xs text-zinc-700">Approximate (±1 chapter)</p>
          </>
        )}
      </div>

      {/* Analyze button */}
      <button
        onClick={onAnalyze}
        disabled={busy}
        className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors ${
          busy
            ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            : canIncrement
            ? 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
            : 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
        }`}
      >
        {analyzing ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-3.5 h-3.5 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin" />
            Analyzing…
          </span>
        ) : canIncrement ? '⚡ Update Characters' : '⌖ Analyze Characters'}
      </button>

      {canIncrement && lastAnalyzedIndex !== null && !busy && (
        <p className="mt-1.5 text-xs text-center text-zinc-600">
          Chapters {lastAnalyzedIndex + 2}–{currentIndex + 1} only
        </p>
      )}

      {/* Rebuild button */}
      <div className="mt-2">
        {rebuilding ? (
          <button
            onClick={onCancelRebuild}
            className="w-full py-2 rounded-lg text-xs font-medium border border-red-800/50 text-red-500 hover:bg-red-950/30 transition-colors"
          >
            Cancel rebuild
            {rebuildProgress && (
              <span className="ml-1 text-red-600">
                ({rebuildProgress.current}/{rebuildProgress.total})
              </span>
            )}
          </button>
        ) : (
          <button
            onClick={onRebuild}
            disabled={busy}
            title="Analyze each chapter individually for the most accurate dataset"
            className={`w-full py-2 rounded-lg text-xs font-medium border transition-colors ${
              busy
                ? 'border-zinc-800 text-zinc-700 cursor-not-allowed'
                : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
            }`}
          >
            Rebuild from scratch
          </button>
        )}
        {!busy && (
          <p className="mt-1 text-xs text-center text-zinc-700">
            Ch.1–{currentIndex + 1}, one by one
          </p>
        )}
      </div>

      {/* Chapter list */}
      <div className="mt-5 flex-1 overflow-y-auto">
        <p className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Chapters</p>
        <ul className="space-y-0.5">
          {chapters.map((ch, i) => {
            const isRebuildingThis = rebuilding && rebuildProgress && i === rebuildProgress.current - 1;
            const hasSnapshot = snapshotIndices?.has(i) ?? false;
            const isLastAnalyzed = lastAnalyzedIndex !== null && i === lastAnalyzedIndex;
            const isAnalyzed = lastAnalyzedIndex !== null && i < lastAnalyzedIndex;
            const prevCh = chapters[i - 1];
            const showBookDivider = ch.bookTitle !== undefined && ch.bookIndex !== prevCh?.bookIndex;
            return (
              <li key={ch.id}>
                {showBookDivider && (
                  <div className="mt-3 mb-1 px-2 flex items-center gap-2">
                    <div className="flex-1 h-px bg-zinc-800" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 whitespace-nowrap">
                      {ch.bookTitle}
                    </span>
                    <div className="flex-1 h-px bg-zinc-800" />
                  </div>
                )}
                <button
                  onClick={() => {
                    onChange(i);
                    if (mode === 'location') setLocationInput(String(chapterIndexToLocation(i, chapters)));
                  }}
                  className={`
                    w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors
                    ${isRebuildingThis
                      ? 'bg-violet-500/10 text-violet-400'
                      : i === currentIndex
                      ? 'bg-zinc-800 text-zinc-100 font-medium'
                      : hasSnapshot
                      ? 'text-amber-600/70 hover:bg-amber-950/30 hover:text-amber-500'
                      : isAnalyzed || isLastAnalyzed
                      ? 'text-zinc-400 hover:bg-zinc-800/60'
                      : i < currentIndex
                      ? 'text-zinc-500 hover:bg-zinc-800/60'
                      : 'text-zinc-700 cursor-default'
                    }
                  `}
                  disabled={i > currentIndex}
                  title={hasSnapshot ? 'Snapshot saved — click to view' : undefined}
                >
                  <span className="mr-1.5 text-[10px]">
                    {isRebuildingThis
                      ? '↻'
                      : isLastAnalyzed
                      ? '★'
                      : hasSnapshot
                      ? '◆'
                      : isAnalyzed
                      ? '✓'
                      : i === currentIndex
                      ? '▸'
                      : i < currentIndex
                      ? '·'
                      : '○'}
                  </span>
                  {ch.title}
                  {mode === 'location' && (
                    <span className="ml-1 text-zinc-600">
                      ~{chapterIndexToLocation(i, chapters).toLocaleString()}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
