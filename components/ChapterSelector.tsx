'use client';

import { useEffect, useState } from 'react';
import type { EbookChapter } from '@/types';
import { normalizeTitle } from '@/lib/normalize-title';

interface Props {
  chapters: EbookChapter[];
  currentIndex: number;
  onChange: (index: number) => void;
  onAnalyze: () => void;
  onCancelAnalyze: () => void;
  onRebuild: () => void;
  onCancelRebuild: () => void;
  analyzing: boolean;
  rebuilding: boolean;
  rebuildProgress: { current: number; total: number } | null;
  lastAnalyzedIndex: number | null;
  snapshotIndices?: Set<number>;
  excludedBooks?: Set<number>;
  onToggleBook?: (bookIndex: number) => void;
  excludedChapters?: Set<number>;
  onToggleChapter?: (chapterIndex: number) => void;
  metaOnly?: boolean;
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

interface ChapterItemProps {
  ch: EbookChapter;
  globalIndex: number;
  currentIndex: number;
  lastAnalyzedIndex: number | null;
  snapshotIndices?: Set<number>;
  isExcluded: boolean;
  rebuilding: boolean;
  rebuildProgress: { current: number; total: number } | null;
  mode: 'chapter' | 'location';
  chapters: EbookChapter[];
  onChange: (index: number) => void;
  setLocationInput: (v: string) => void;
  onToggleChapter?: (index: number) => void;
}

function ChapterItem({
  ch, globalIndex, currentIndex, lastAnalyzedIndex, snapshotIndices,
  isExcluded, rebuilding, rebuildProgress, mode, chapters, onChange, setLocationInput, onToggleChapter,
}: ChapterItemProps) {
  const isRebuildingThis = rebuilding && rebuildProgress && globalIndex === rebuildProgress.current - 1;
  const hasSnapshot = snapshotIndices?.has(globalIndex) ?? false;
  const isLastAnalyzed = lastAnalyzedIndex !== null && globalIndex === lastAnalyzedIndex;
  const isAnalyzed = lastAnalyzedIndex !== null && globalIndex < lastAnalyzedIndex;
  const isCurrent = globalIndex === currentIndex;
  // Chapters up to the furthest point the user has reached (read or analyzed) are navigable
  const frontier = Math.max(currentIndex, lastAnalyzedIndex ?? -1);

  const marker = isExcluded ? '✗'
    : isRebuildingThis ? '↻'
    : isLastAnalyzed ? '★'
    : hasSnapshot ? '◆'
    : isAnalyzed ? '✓'
    : isCurrent ? '▸'
    : globalIndex < currentIndex ? '·'
    : '○';

  const color = isExcluded ? 'text-stone-200 dark:text-zinc-800 cursor-default'
    : isRebuildingThis ? 'bg-violet-500/10 text-violet-400'
    : isCurrent ? 'bg-stone-100 dark:bg-zinc-800 text-stone-900 dark:text-zinc-100 font-medium'
    : hasSnapshot ? 'text-amber-600/70 hover:bg-amber-950/30 hover:text-amber-500'
    : isAnalyzed || isLastAnalyzed ? 'text-stone-500 dark:text-zinc-400 hover:bg-stone-100/60 dark:hover:bg-zinc-800/60'
    : globalIndex <= frontier ? 'text-stone-400 dark:text-zinc-500 hover:bg-stone-100/60 dark:hover:bg-zinc-800/60'
    : 'text-stone-300 dark:text-zinc-700 cursor-default';

  return (
    <div className="flex items-center group">
      <button
        onClick={() => {
          onChange(globalIndex);
          if (mode === 'location') setLocationInput(String(chapterIndexToLocation(globalIndex, chapters)));
        }}
        disabled={globalIndex > frontier || isExcluded}
        title={hasSnapshot ? 'Snapshot saved' : undefined}
        className={`flex-1 text-left px-2.5 py-1.5 rounded-md text-xs transition-colors ${color}`}
      >
        <span className="mr-1.5 text-[10px]">{marker}</span>
        {normalizeTitle(ch.title)}
        {mode === 'location' && (
          <span className="ml-1 text-stone-400 dark:text-zinc-600">~{chapterIndexToLocation(globalIndex, chapters).toLocaleString()}</span>
        )}
      </button>
      {onToggleChapter && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleChapter(globalIndex); }}
          title={isExcluded ? 'Include in analysis' : 'Exclude from analysis'}
          className={`flex-shrink-0 ml-1 w-4 h-4 flex items-center justify-center rounded text-[9px] opacity-0 group-hover:opacity-100 transition-opacity ${
            isExcluded
              ? 'text-stone-400 dark:text-zinc-500 hover:text-stone-800 dark:hover:text-zinc-300 opacity-100'
              : 'text-stone-300 dark:text-zinc-700 hover:text-red-500/70'
          }`}
        >
          {isExcluded ? '↩' : '✕'}
        </button>
      )}
    </div>
  );
}

export default function ChapterSelector({
  chapters, currentIndex, onChange, onAnalyze, onCancelAnalyze, onRebuild, onCancelRebuild,
  analyzing, rebuilding, rebuildProgress, lastAnalyzedIndex,
  snapshotIndices, excludedBooks, onToggleBook, excludedChapters, onToggleChapter, metaOnly,
}: Props) {
  const [mode, setMode] = useState<'chapter' | 'location'>('chapter');
  const [locationInput, setLocationInput] = useState('');

  const isOmnibus = chapters.some((ch) => ch.bookIndex !== undefined);
  const totalLocations = chapterIndexToLocation(chapters.length - 1, chapters);
  const busy = analyzing || rebuilding || !!metaOnly;

  // Build book groups (omnibus only)
  const bookGroups = new Map<number, {
    bookTitle: string;
    items: Array<{ ch: EbookChapter; globalIndex: number; chapterNum: number }>;
  }>();
  if (isOmnibus) {
    const counters = new Map<number, number>();
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const bIdx = ch.bookIndex ?? 0;
      if (!bookGroups.has(bIdx)) bookGroups.set(bIdx, { bookTitle: ch.bookTitle ?? '', items: [] });
      const num = (counters.get(bIdx) ?? 0) + 1;
      counters.set(bIdx, num);
      bookGroups.get(bIdx)!.items.push({ ch, globalIndex: i, chapterNum: num });
    }
  }

  // Auto-expand the book containing currentIndex
  const currentBookIdx = isOmnibus ? (chapters[currentIndex]?.bookIndex ?? 0) : undefined;
  const [expandedBooks, setExpandedBooks] = useState<Set<number>>(() =>
    currentBookIdx !== undefined ? new Set([currentBookIdx]) : new Set(),
  );
  useEffect(() => {
    if (currentBookIdx !== undefined) {
      setExpandedBooks((prev) => prev.has(currentBookIdx) ? prev : new Set([...prev, currentBookIdx]));
    }
  }, [currentBookIdx]);

  function toggleExpand(bookIdx: number) {
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookIdx)) next.delete(bookIdx); else next.add(bookIdx);
      return next;
    });
  }

  function handleLocationChange(raw: string) {
    setLocationInput(raw);
    const loc = parseInt(raw, 10);
    if (!isNaN(loc) && loc > 0) onChange(locationToChapterIndex(loc, chapters));
  }

  function handleModeSwitch(next: 'chapter' | 'location') {
    setMode(next);
    if (next === 'location') setLocationInput(String(chapterIndexToLocation(currentIndex, chapters)));
  }

  const itemProps = { currentIndex, lastAnalyzedIndex, snapshotIndices, rebuilding, rebuildProgress, mode, chapters, onChange, setLocationInput, onToggleChapter };

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-stone-300 dark:border-zinc-700 mb-4">
        {(['chapter', 'location'] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeSwitch(m)}
            className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
              mode === m ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100' : 'bg-transparent text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
            }`}
          >
            {m === 'chapter' ? 'By Chapter' : 'Kindle Location'}
          </button>
        ))}
      </div>

      {/* Currently at */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Currently at</label>
        {mode === 'chapter' ? (
          <>
            <div className="relative">
              <select
                value={currentIndex}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full appearance-none bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2.5 pr-8 text-stone-800 dark:text-zinc-200 text-sm focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500 cursor-pointer"
              >
                {isOmnibus
                  ? [...bookGroups.entries()].map(([bookIdx, { bookTitle, items }]) => (
                      <optgroup key={bookIdx} label={bookTitle}>
                        {items.map(({ ch, globalIndex, chapterNum }) => (
                          <option key={ch.id} value={globalIndex}>Ch. {chapterNum} — {normalizeTitle(ch.title)}</option>
                        ))}
                      </optgroup>
                    ))
                  : chapters.map((ch, i) => (
                      <option key={ch.id} value={i}>{i + 1}. {normalizeTitle(ch.title)}</option>
                    ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-stone-400 dark:text-zinc-500">▾</div>
            </div>
            <p className="mt-1.5 text-xs text-stone-400 dark:text-zinc-600">
              {(() => {
                const ch = chapters[currentIndex];
                if (!ch || ch.bookIndex === undefined) return `${currentIndex + 1} of ${chapters.length} chapters`;
                let num = 0, bookTotal = 0;
                for (const c of chapters) {
                  if (c.bookIndex === ch.bookIndex) { bookTotal++; if (c.order <= ch.order) num++; }
                }
                return `Ch. ${num} of ${bookTotal} · ${ch.bookTitle}`;
              })()}
            </p>
          </>
        ) : (
          <>
            <input
              type="number" min={1} max={totalLocations} value={locationInput}
              onChange={(e) => handleLocationChange(e.target.value)}
              placeholder="e.g. 3421"
              className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2.5 text-stone-800 dark:text-zinc-200 text-sm focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500"
            />
            <p className="mt-1.5 text-xs text-stone-400 dark:text-zinc-600">≈ {normalizeTitle(chapters[currentIndex]?.title ?? '')} · ~{totalLocations.toLocaleString()} total</p>
            <p className="mt-0.5 text-xs text-stone-300 dark:text-zinc-700">Approximate (±1 chapter)</p>
          </>
        )}
      </div>

      {/* Analyze */}
      {analyzing ? (
        <button onClick={onCancelAnalyze} className="w-full py-2.5 rounded-lg text-sm font-semibold border border-red-800/50 text-red-400 hover:bg-red-950/30 transition-colors">
          Cancel
          {rebuildProgress && <span className="ml-1.5 text-red-600 text-xs">({rebuildProgress.current}/{rebuildProgress.total})</span>}
        </button>
      ) : (
        <button
          onClick={onAnalyze} disabled={busy}
          title={metaOnly ? 'Re-upload EPUB to analyze' : undefined}
          className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors ${
            busy ? 'bg-stone-100 dark:bg-zinc-800 text-stone-400 dark:text-zinc-600 cursor-not-allowed' : 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
          }`}
        >
          ⌖ Analyze Chapters
        </button>
      )}
      {metaOnly && (
        <p className="mt-1.5 text-xs text-center text-stone-400 dark:text-zinc-600">Re-upload EPUB to analyze</p>
      )}
      {!busy && !metaOnly && lastAnalyzedIndex !== null && lastAnalyzedIndex >= 0 && lastAnalyzedIndex < currentIndex && (
        <p className="mt-1.5 text-xs text-center text-stone-400 dark:text-zinc-600">Ch.{lastAnalyzedIndex + 2}–{currentIndex + 1} · chapter by chapter</p>
      )}

      {/* Rebuild */}
      <div className="mt-2">
        {rebuilding ? (
          <button onClick={onCancelRebuild} className="w-full py-2 rounded-lg text-xs font-medium border border-red-800/50 text-red-500 hover:bg-red-950/30 transition-colors">
            Cancel rebuild
            {rebuildProgress && <span className="ml-1 text-red-600">({rebuildProgress.current}/{rebuildProgress.total})</span>}
          </button>
        ) : (
          <button
            onClick={onRebuild} disabled={busy}
            title="Re-analyze from chapter 1, overwriting existing data"
            className={`w-full py-2 rounded-lg text-xs font-medium border transition-colors ${
              busy ? 'border-stone-200 dark:border-zinc-800 text-stone-300 dark:text-zinc-700 cursor-not-allowed' : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 hover:border-stone-400 dark:hover:border-zinc-600'
            }`}
          >
            Rebuild from scratch
          </button>
        )}
        {!busy && <p className="mt-1 text-xs text-center text-stone-300 dark:text-zinc-700">Re-analyze ch.1–{currentIndex + 1} from scratch</p>}
      </div>

      {/* Chapter list */}
      <div className="mt-5 flex-1 overflow-y-auto">
        <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-2">Chapters</p>

        {isOmnibus ? (
          <ul className="space-y-1.5">
            {[...bookGroups.entries()].map(([bookIdx, { bookTitle, items }]) => {
              const isExpanded = expandedBooks.has(bookIdx);
              const isExcluded = excludedBooks?.has(bookIdx) ?? false;
              const analyzedCount = items.filter(({ globalIndex }) =>
                lastAnalyzedIndex !== null && globalIndex <= lastAnalyzedIndex,
              ).length;
              const isCurrent = items.some(({ globalIndex }) => globalIndex === currentIndex);

              return (
                <li key={bookIdx}>
                  {/* Book header */}
                  <div className={`flex items-center rounded-lg border transition-colors ${
                    isExcluded
                      ? 'border-stone-200/40 dark:border-zinc-800/40 bg-transparent'
                      : isCurrent
                      ? 'border-amber-500/20 bg-amber-500/5'
                      : 'border-stone-200 dark:border-zinc-800 bg-stone-100/20 dark:bg-zinc-800/20 hover:bg-stone-100/40 dark:hover:bg-zinc-800/40'
                  }`}>
                    <button
                      onClick={() => toggleExpand(bookIdx)}
                      className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0"
                    >
                      <span className={`flex-shrink-0 text-[10px] ${isExcluded ? 'text-stone-300 dark:text-zinc-700' : isExpanded ? 'text-stone-500 dark:text-zinc-400' : 'text-stone-400 dark:text-zinc-600'}`}>
                        {isExpanded ? '▾' : '▸'}
                      </span>
                      <span className={`text-xs font-semibold truncate ${isExcluded ? 'text-stone-300 dark:text-zinc-700 line-through' : isCurrent ? 'text-amber-400/80' : 'text-stone-500 dark:text-zinc-400'}`}>
                        {bookTitle}
                      </span>
                    </button>
                    <div className="flex items-center gap-1.5 pr-2 flex-shrink-0">
                      {!isExcluded && (
                        <span className="text-[10px] text-stone-400 dark:text-zinc-600">
                          {analyzedCount > 0 ? `${analyzedCount}/${items.length}` : `${items.length} ch.`}
                        </span>
                      )}
                      <button
                        onClick={() => onToggleBook?.(bookIdx)}
                        title={isExcluded ? 'Include this book' : 'Exclude this book'}
                        className={`text-[10px] w-5 h-5 flex items-center justify-center rounded border transition-colors ${
                          isExcluded
                            ? 'border-stone-200 dark:border-zinc-800 text-stone-300 dark:text-zinc-700 hover:border-stone-300 dark:hover:border-zinc-700 hover:text-stone-400 dark:hover:text-zinc-500'
                            : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-500 hover:border-red-900/60 hover:text-red-500/60'
                        }`}
                      >
                        {isExcluded ? '✗' : '✓'}
                      </button>
                    </div>
                  </div>

                  {/* Chapters (expanded) */}
                  {isExpanded && (
                    <ul className="mt-0.5 ml-2 space-y-0.5 border-l border-stone-200 dark:border-zinc-800 pl-2">
                      {items.map(({ ch, globalIndex }) => (
                        <ChapterItem key={ch.id} ch={ch} globalIndex={globalIndex} isExcluded={isExcluded || (excludedChapters?.has(globalIndex) ?? false)} {...itemProps} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          /* Flat list for non-omnibus */
          <ul className="space-y-0.5">
            {chapters.map((ch, i) => (
              <ChapterItem key={ch.id} ch={ch} globalIndex={i} isExcluded={excludedChapters?.has(i) ?? false} {...itemProps} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
