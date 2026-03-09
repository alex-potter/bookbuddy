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
}

// 1 Kindle location ≈ 128 bytes of text
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
}: Props) {
  const [mode, setMode] = useState<'chapter' | 'location'>('chapter');
  const [locationInput, setLocationInput] = useState('');

  const totalLocations = chapterIndexToLocation(chapters.length - 1, chapters);
  const busy = analyzing || rebuilding;

  function handleLocationChange(raw: string) {
    setLocationInput(raw);
    const loc = parseInt(raw, 10);
    if (!isNaN(loc) && loc > 0) {
      onChange(locationToChapterIndex(loc, chapters));
    }
  }

  function handleModeSwitch(next: 'chapter' | 'location') {
    setMode(next);
    if (next === 'location') {
      setLocationInput(String(chapterIndexToLocation(currentIndex, chapters)));
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle */}
      <div className="flex rounded-xl overflow-hidden border border-amber-200 mb-4">
        {(['chapter', 'location'] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeSwitch(m)}
            className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
              mode === m
                ? 'bg-amber-500 text-white'
                : 'bg-white text-amber-600 hover:bg-amber-50'
            }`}
          >
            {m === 'chapter' ? 'By Chapter' : 'Kindle Location'}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-amber-600 mb-2">
          I am currently at…
        </label>

        {mode === 'chapter' ? (
          <>
            <div className="relative">
              <select
                value={currentIndex}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full appearance-none bg-white border border-amber-200 rounded-xl px-4 py-3 pr-10 text-amber-900 font-medium text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 cursor-pointer"
              >
                {chapters.map((ch, i) => (
                  <option key={ch.id} value={i}>
                    {i + 1}. {ch.title}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-amber-400">
                ▾
              </div>
            </div>
            <p className="mt-2 text-xs text-amber-500">
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
              className="w-full bg-white border border-amber-200 rounded-xl px-4 py-3 text-amber-900 font-medium text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <p className="mt-2 text-xs text-amber-500">
              ≈ {chapters[currentIndex]?.title} · book total ~{totalLocations.toLocaleString()} loc
            </p>
            <p className="mt-1 text-xs text-amber-400">
              Location numbers are approximate (±1 chapter)
            </p>
          </>
        )}
      </div>

      {/* Analyze button */}
      <button
        onClick={onAnalyze}
        disabled={busy}
        className={`
          w-full py-3 rounded-xl font-semibold text-sm transition-all duration-200
          ${busy
            ? 'bg-amber-200 text-amber-500 cursor-not-allowed'
            : 'bg-amber-500 text-white hover:bg-amber-600 active:scale-95 shadow-md hover:shadow-lg'
          }
        `}
      >
        {analyzing ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            Analyzing…
          </span>
        ) : canIncrement ? (
          '⚡ Update Characters'
        ) : (
          '🔍 Analyze Characters'
        )}
      </button>

      {canIncrement && lastAnalyzedIndex !== null && !busy && (
        <p className="mt-1.5 text-xs text-center text-amber-400">
          Only reading ch.{lastAnalyzedIndex + 2}–{currentIndex + 1}
        </p>
      )}

      {/* Rebuild button */}
      <div className="mt-2">
        {rebuilding ? (
          <button
            onClick={onCancelRebuild}
            className="w-full py-2 rounded-xl text-xs font-semibold border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
          >
            Cancel rebuild
            {rebuildProgress && (
              <span className="ml-1 text-red-400">
                ({rebuildProgress.current}/{rebuildProgress.total})
              </span>
            )}
          </button>
        ) : (
          <button
            onClick={onRebuild}
            disabled={busy}
            title="Analyze each chapter one-by-one for the most accurate character dataset"
            className={`
              w-full py-2 rounded-xl text-xs font-semibold border transition-colors
              ${busy
                ? 'border-stone-100 text-stone-300 cursor-not-allowed'
                : 'border-violet-200 text-violet-500 hover:bg-violet-50'
              }
            `}
          >
            🔄 Rebuild from scratch
          </button>
        )}
        {!busy && (
          <p className="mt-1 text-xs text-center text-stone-400">
            Analyzes ch.1–{currentIndex + 1} one by one
          </p>
        )}
      </div>

      {/* Chapter list */}
      <div className="mt-5 flex-1 overflow-y-auto">
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-500 mb-2">
          Chapters
        </p>
        <ul className="space-y-0.5">
          {chapters.map((ch, i) => {
            const isRebuildingThis = rebuilding && rebuildProgress && i === rebuildProgress.current - 1;
            return (
              <li key={ch.id}>
                <button
                  onClick={() => {
                    onChange(i);
                    if (mode === 'location') {
                      setLocationInput(String(chapterIndexToLocation(i, chapters)));
                    }
                  }}
                  className={`
                    w-full text-left px-3 py-2 rounded-lg text-sm transition-colors
                    ${isRebuildingThis
                      ? 'bg-violet-100 text-violet-800 font-semibold'
                      : i === currentIndex
                      ? 'bg-amber-100 text-amber-900 font-semibold'
                      : lastAnalyzedIndex !== null && i <= lastAnalyzedIndex
                      ? 'text-amber-700 hover:bg-amber-50'
                      : i < currentIndex
                      ? 'text-amber-600 hover:bg-amber-50'
                      : 'text-amber-300 cursor-default'
                    }
                  `}
                  disabled={i > currentIndex}
                  title={i > currentIndex ? "You haven't read this chapter yet" : ''}
                >
                  <span className="mr-2 text-xs">
                    {isRebuildingThis
                      ? '↻'
                      : lastAnalyzedIndex !== null && i < lastAnalyzedIndex
                      ? '✓'
                      : lastAnalyzedIndex !== null && i === lastAnalyzedIndex
                      ? '★'
                      : i === currentIndex
                      ? '▸'
                      : i < currentIndex
                      ? '·'
                      : '○'}
                  </span>
                  {ch.title}
                  {mode === 'location' && (
                    <span className="ml-1 text-xs text-amber-400">
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
