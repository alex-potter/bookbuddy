'use client';

import { useEffect, useRef, useState } from 'react';
import type { EbookChapter, BookContainer } from '@/types';
import { normalizeTitle } from '@/lib/normalize-title';
import { getDisplayLabel, displayChapterNumber, findBookForChapter } from '@/lib/series';

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
  rebuildProgress: { current: number; total: number; chapterTitle?: string; chapterIndex?: number } | null;
  lastAnalyzedIndex: number | null;
  snapshotIndices?: Set<number>;
  visibleChapterOrders?: Set<number> | null;
  chapterRange?: { start: number; end: number } | null;
  onSetRange?: (range: { start: number; end: number } | null) => void;
  onProcessBook?: () => void;
  onDeleteSnapshot?: (chapterIndex: number) => void;
  readingBookmark?: number;
  onSetBookmark?: (chapterIndex: number | null) => void;
  metaOnly?: boolean;
  needsSetup?: boolean;
  onCompleteSetup?: (range: { start: number; end: number }) => void;
  container?: BookContainer;
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
  rebuildProgress: { current: number; total: number; chapterTitle?: string; chapterIndex?: number } | null;
  mode: 'chapter' | 'location';
  chapters: EbookChapter[];
  onChange: (index: number) => void;
  setLocationInput: (v: string) => void;
  onDeleteSnapshot?: (index: number) => void;
  isRangeStart?: boolean;
  isRangeEnd?: boolean;
  onSetRangeStart?: (index: number) => void;
  onSetRangeEnd?: (index: number) => void;
  readingBookmark?: number;
  onSetBookmark?: (chapterIndex: number | null) => void;
}

function ChapterItem({
  ch, globalIndex, currentIndex, lastAnalyzedIndex, snapshotIndices,
  isExcluded, rebuilding, rebuildProgress, mode, chapters, onChange, setLocationInput, onDeleteSnapshot,
  isRangeStart, isRangeEnd, onSetRangeStart, onSetRangeEnd,
  readingBookmark, onSetBookmark,
}: ChapterItemProps) {
  const isRebuildingThis = rebuilding && rebuildProgress && globalIndex === (rebuildProgress.chapterIndex ?? rebuildProgress.current - 1);
  const hasSnapshot = snapshotIndices?.has(globalIndex) ?? false;
  const isLastAnalyzed = lastAnalyzedIndex !== null && globalIndex === lastAnalyzedIndex;
  const isAnalyzed = lastAnalyzedIndex !== null && globalIndex < lastAnalyzedIndex;
  const isCurrent = globalIndex === currentIndex;
  // Chapters up to the furthest point the user has reached (read or analyzed) are navigable
  const frontier = Math.max(currentIndex, lastAnalyzedIndex ?? -1);

  const isBeyondBookmark = readingBookmark != null && globalIndex > readingBookmark;

  const marker = isExcluded ? '✗'
    : isRangeStart && isRangeEnd ? '⊡'
    : isRangeStart ? '⌞'
    : isRangeEnd ? '⌟'
    : isRebuildingThis ? '↻'
    : isLastAnalyzed ? '★'
    : hasSnapshot ? '◆'
    : isAnalyzed ? '✓'
    : isCurrent ? '▸'
    : globalIndex < currentIndex ? '·'
    : '○';

  const color = isExcluded ? 'text-ink-dim/30 cursor-default'
    : isRebuildingThis ? 'bg-violet-500/10 text-violet-400'
    : isCurrent ? 'bg-paper-dark text-ink font-semibold'
    : hasSnapshot ? 'text-amber/70 hover:bg-amber-500/10 hover:text-amber'
    : isAnalyzed || isLastAnalyzed ? 'text-ink-soft hover:bg-paper'
    : globalIndex <= frontier ? 'text-ink-dim hover:bg-paper'
    : 'text-ink-dim/40 cursor-default';

  return (
    <div className="flex items-center group">
      <button
        onClick={() => {
          onChange(globalIndex);
          if (mode === 'location') setLocationInput(String(chapterIndexToLocation(globalIndex, chapters)));
        }}
        disabled={globalIndex > frontier || isExcluded}
        title={hasSnapshot ? 'Snapshot saved' : undefined}
        className={`flex-1 text-left px-2.5 py-1.5 rounded-md text-xs transition-colors ${color}${isBeyondBookmark ? ' opacity-50' : ''}`}
      >
        <span className="mr-1.5 text-[10px]">{marker}</span>
        {normalizeTitle(ch.title)}
        {mode === 'location' && (
          <span className="ml-1 text-ink-dim">~{chapterIndexToLocation(globalIndex, chapters).toLocaleString()}</span>
        )}
      </button>
      {onSetBookmark && (
        <button
          onClick={(e) => { e.stopPropagation(); onSetBookmark(globalIndex === readingBookmark ? null : globalIndex); }}
          className={`flex-shrink-0 ml-0.5 w-4 h-4 flex items-center justify-center rounded text-[9px] transition-opacity ${
            globalIndex === readingBookmark
              ? 'text-amber opacity-100'
              : 'text-ink-dim/40 hover:text-amber opacity-0 group-hover:opacity-100'
          }`}
          title={globalIndex === readingBookmark ? 'Clear bookmark' : 'Bookmark here'}
        >
          <svg width="8" height="11" viewBox="0 0 10 14" fill="currentColor">
            <path d="M0 0h10v14L5 10.5 0 14V0z"/>
          </svg>
        </button>
      )}
      {onSetRangeStart && (
        <button
          onClick={(e) => { e.stopPropagation(); onSetRangeStart(globalIndex); }}
          title="Set as analysis start"
          className={`flex-shrink-0 ml-0.5 w-4 h-4 flex items-center justify-center rounded text-[9px] transition-opacity ${
            isRangeStart
              ? 'text-amber opacity-100'
              : 'text-ink-dim/40 hover:text-amber opacity-0 group-hover:opacity-100'
          }`}
        >
          ⌞
        </button>
      )}
      {onSetRangeEnd && (
        <button
          onClick={(e) => { e.stopPropagation(); onSetRangeEnd(globalIndex); }}
          title="Set as analysis end"
          className={`flex-shrink-0 ml-0.5 w-4 h-4 flex items-center justify-center rounded text-[9px] transition-opacity ${
            isRangeEnd
              ? 'text-amber opacity-100'
              : 'text-ink-dim/40 hover:text-amber opacity-0 group-hover:opacity-100'
          }`}
        >
          ⌟
        </button>
      )}
      {onDeleteSnapshot && hasSnapshot && (
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteSnapshot(globalIndex); }}
          title="Delete this snapshot (and all later ones)"
          className="flex-shrink-0 ml-0.5 w-4 h-4 flex items-center justify-center rounded text-[9px] opacity-0 group-hover:opacity-100 transition-opacity text-ink-dim/40 hover:text-danger"
        >
          🗑
        </button>
      )}
    </div>
  );
}

interface ComboboxProps {
  chapters: EbookChapter[];
  currentIndex: number;
  lastAnalyzedIndex: number | null;
  isOmnibus: boolean;
  bookGroups: Map<number, { bookTitle: string; items: Array<{ ch: EbookChapter; globalIndex: number; chapterNum: number }> }>;
  onChange: (index: number) => void;
  container?: BookContainer;
}

function ChapterCombobox({ chapters, currentIndex, lastAnalyzedIndex, isOmnibus, bookGroups, onChange, container }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentCh = chapters[currentIndex];
  const displayLabel = currentCh ? normalizeTitle(currentCh.title) : '—';
  const subLabel = (() => {
    if (!currentCh) return '';
    if (container) return getDisplayLabel(container, currentCh.order);
    if (currentCh.bookIndex === undefined) return `${currentIndex + 1} of ${chapters.length} chapters`;
    let num = 0, bookTotal = 0;
    for (const c of chapters) {
      if (c.bookIndex === currentCh.bookIndex) { bookTotal++; if (c.order <= currentCh.order) num++; }
    }
    return `Ch. ${num} of ${bookTotal} · ${currentCh.bookTitle}`;
  })();

  // Flat list for filtering
  type FlatItem = { globalIndex: number; label: string; groupLabel?: string; chapterNum?: number };
  const flatItems: FlatItem[] = isOmnibus
    ? [...bookGroups.entries()].flatMap(([, { bookTitle, items }]) =>
        items.map(({ ch, globalIndex, chapterNum }) => ({
          globalIndex,
          chapterNum: container ? displayChapterNumber(container, ch.bookIndex ?? 0, ch.order) : chapterNum,
          label: normalizeTitle(ch.title),
          groupLabel: container ? (findBookForChapter(container, ch.order)?.title ?? bookTitle) : bookTitle,
        })),
      )
    : chapters.map((ch, i) => ({
        globalIndex: i,
        label: normalizeTitle(ch.title),
        chapterNum: container ? displayChapterNumber(container, 0, ch.order) : undefined,
      }));

  const q = query.toLowerCase();
  const filtered = q
    ? flatItems.filter((it) =>
        it.label.toLowerCase().includes(q) ||
        it.groupLabel?.toLowerCase().includes(q) ||
        String(it.chapterNum ?? it.globalIndex + 1).startsWith(q),
      )
    : flatItems;

  function openDropdown() {
    setQuery('');
    setOpen(true);
    setTimeout(() => {
      // Scroll active item into view
      const active = listRef.current?.querySelector('[data-active="true"]');
      active?.scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  function select(index: number) {
    onChange(index);
    setOpen(false);
    setQuery('');
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); }
    if (e.key === 'Enter' && filtered.length > 0) { select(filtered[0].globalIndex); }
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) { setOpen(false); setQuery(''); }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Group filtered items by book for omnibus display
  const groups: Array<{ label?: string; items: FlatItem[] }> = [];
  if (isOmnibus) {
    const seen = new Map<string, FlatItem[]>();
    for (const it of filtered) {
      const g = it.groupLabel ?? '';
      if (!seen.has(g)) { seen.set(g, []); groups.push({ label: g, items: seen.get(g)! }); }
      seen.get(g)!.push(it);
    }
  } else {
    groups.push({ items: filtered });
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={openDropdown}
        className="w-full flex items-center justify-between bg-paper border border-border rounded-lg px-3 py-2.5 text-left focus:outline-none focus:border-rust hover:border-ink-dim transition-colors"
      >
        <span className="text-sm text-ink truncate min-w-0 font-serif">{displayLabel}</span>
        <span className="flex-shrink-0 ml-2 text-ink-dim text-xs">▾</span>
      </button>
      <p className="mt-1.5 text-xs text-ink-dim">{subLabel}</p>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-paper-raised border border-border rounded-lg shadow-xl flex flex-col max-h-72 overflow-hidden">
          {/* Search input */}
          <div className="px-2 pt-2 pb-1.5 border-b border-border">
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Search chapters…"
              className="w-full bg-paper border border-border rounded-md px-2.5 py-1.5 text-xs text-ink placeholder-ink-dim focus:outline-none focus:border-rust font-serif"
            />
          </div>
          {/* List */}
          <div ref={listRef} className="overflow-y-auto flex-1">
            {groups.length === 0 || (groups.length === 1 && groups[0].items.length === 0) ? (
              <p className="px-3 py-4 text-xs text-ink-dim text-center">No chapters match</p>
            ) : (
              groups.map((group, gi) => (
                <div key={gi}>
                  {group.label && (
                    <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-dim">{group.label}</div>
                  )}
                  {group.items.map((it) => {
                    const isActive = it.globalIndex === currentIndex;
                    const analyzed = lastAnalyzedIndex !== null && it.globalIndex <= lastAnalyzedIndex;
                    return (
                      <button
                        key={it.globalIndex}
                        data-active={isActive}
                        onClick={() => select(it.globalIndex)}
                        className={`w-full text-left px-3 py-1.5 text-xs font-serif transition-colors ${
                          isActive
                            ? 'bg-amber-500/10 text-amber font-medium'
                            : analyzed
                            ? 'text-amber/60 hover:bg-paper'
                            : 'text-ink hover:bg-paper'
                        }`}
                      >
                        <span className="text-ink-dim mr-1.5 tabular-nums font-mono">
                          {it.chapterNum !== undefined ? `${it.chapterNum}.` : `${it.globalIndex + 1}.`}
                        </span>
                        {it.label}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChapterSelector({
  chapters, currentIndex, onChange, onAnalyze, onCancelAnalyze, onRebuild, onCancelRebuild,
  analyzing, rebuilding, rebuildProgress, lastAnalyzedIndex,
  snapshotIndices, visibleChapterOrders,
  chapterRange, onSetRange, onProcessBook, onDeleteSnapshot, readingBookmark, onSetBookmark, metaOnly,
  needsSetup, onCompleteSetup, container,
}: Props) {
  const [mode, setMode] = useState<'chapter' | 'location'>('chapter');
  const [locationInput, setLocationInput] = useState('');

  const isOmnibus = chapters.some((ch) => ch.bookIndex !== undefined);
  const totalLocations = chapterIndexToLocation(chapters.length - 1, chapters);
  const busy = analyzing || rebuilding || !!metaOnly;

  // Build book groups (omnibus only), filtering by visibleChapterOrders
  const bookGroups = new Map<number, {
    bookTitle: string;
    items: Array<{ ch: EbookChapter; globalIndex: number; chapterNum: number }>;
  }>();
  if (isOmnibus) {
    const counters = new Map<number, number>();
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      if (visibleChapterOrders && !visibleChapterOrders.has(i)) continue;
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

  function handleSetRangeStart(index: number) {
    const end = chapterRange?.end ?? (chapters.length - 1);
    onSetRange?.({ start: index, end: Math.max(index, end) });
  }

  function handleSetRangeEnd(index: number) {
    const start = chapterRange?.start ?? 0;
    onSetRange?.({ start: Math.min(start, index), end: index });
  }

  const rangeStart = chapterRange?.start;
  const rangeEnd = chapterRange?.end;
  const itemProps = {
    currentIndex, lastAnalyzedIndex, snapshotIndices, rebuilding, rebuildProgress, mode, chapters, onChange, setLocationInput,
    onDeleteSnapshot,
    onSetRangeStart: onSetRange ? handleSetRangeStart : undefined,
    onSetRangeEnd: onSetRange ? handleSetRangeEnd : undefined,
    readingBookmark,
    onSetBookmark,
  };

  if (needsSetup && onCompleteSetup) {
    const setupStart = chapterRange?.start ?? 0;
    const setupEnd = chapterRange?.end ?? (chapters.length - 1);
    return (
      <div className="flex flex-col h-full">
        <h2 className="text-sm font-semibold text-ink mb-1 font-serif">Set up your book</h2>
        <p className="text-xs text-ink-dim mb-4">
          Choose which chapters to analyze. Front &amp; back matter have been auto-detected — adjust if needed.
        </p>

        {/* Range summary */}
        <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-1.5 mb-4">
          <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Analysis range</p>
          <div className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="text-amber font-bold">Start:</span>
            <span className="truncate flex-1 min-w-0">
              {normalizeTitle(chapters[setupStart]?.title ?? '') || `Ch. ${setupStart + 1}`}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="text-amber font-bold">End:</span>
            <span className="truncate flex-1 min-w-0">
              {normalizeTitle(chapters[setupEnd]?.title ?? '') || `Ch. ${setupEnd + 1}`}
            </span>
          </div>
        </div>

        {/* Chapter list */}
        <div className="flex-1 overflow-y-auto mb-4">
          <ul className="space-y-0.5">
            {chapters.map((ch, i) => {
              const inRange = i >= setupStart && i <= setupEnd;
              const isStart = i === setupStart;
              const isEnd = i === setupEnd;
              return (
                <li key={ch.id} className={`flex items-center gap-1 rounded-md transition-colors ${
                  isStart || isEnd ? 'bg-amber-500/10' : ''
                }`}>
                  <span className={`flex-1 text-xs px-2 py-1.5 truncate font-serif ${
                    isStart || isEnd
                      ? 'text-amber font-semibold'
                      : inRange
                      ? 'text-ink'
                      : 'text-ink-dim/40'
                  }`}>
                    <span className="text-ink-dim mr-1.5 tabular-nums text-[10px] font-mono">{i + 1}.</span>
                    {normalizeTitle(ch.title)}
                  </span>
                  <button
                    onClick={() => handleSetRangeStart(i)}
                    className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      isStart
                        ? 'text-amber-500 bg-amber-500/20'
                        : 'text-ink-dim hover:text-amber hover:bg-amber-500/10'
                    }`}
                  >
                    Start
                  </button>
                  <button
                    onClick={() => handleSetRangeEnd(i)}
                    className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      isEnd
                        ? 'text-amber-500 bg-amber-500/20'
                        : 'text-ink-dim hover:text-amber hover:bg-amber-500/10'
                    }`}
                  >
                    End
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Confirm button */}
        <button
          onClick={() => onCompleteSetup({ start: setupStart, end: setupEnd })}
          className="w-full py-2.5 rounded-lg text-sm font-semibold bg-rust text-white hover:bg-rust/90 transition-colors"
        >
          Confirm &amp; Continue
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-border mb-4">
        {(['chapter', 'location'] as const).map((m) => (
          <button
            key={m}
            onClick={() => handleModeSwitch(m)}
            className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
              mode === m ? 'bg-paper-dark text-ink' : 'bg-transparent text-ink-dim hover:text-ink'
            }`}
          >
            {m === 'chapter' ? 'By Chapter' : 'Kindle Location'}
          </button>
        ))}
      </div>

      {/* Currently at */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-ink-dim uppercase tracking-wider mb-2">Currently at</label>
        {mode === 'chapter' ? (
          <ChapterCombobox
            chapters={chapters}
            currentIndex={currentIndex}
            lastAnalyzedIndex={lastAnalyzedIndex}
            isOmnibus={isOmnibus}
            bookGroups={bookGroups}
            onChange={onChange}
            container={container}
          />
        ) : (
          <>
            <input
              type="number" min={1} max={totalLocations} value={locationInput}
              onChange={(e) => handleLocationChange(e.target.value)}
              placeholder="e.g. 3421"
              className="w-full bg-paper border border-border rounded-lg px-3 py-2.5 text-ink text-sm focus:outline-none focus:border-rust"
            />
            <p className="mt-1.5 text-xs text-ink-dim">≈ {normalizeTitle(chapters[currentIndex]?.title ?? '')} · ~{totalLocations.toLocaleString()} total</p>
            <p className="mt-0.5 text-xs text-ink-dim/50">Approximate (±1 chapter)</p>
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
            busy ? 'bg-paper-dark text-ink-dim cursor-not-allowed' : 'bg-rust text-white hover:bg-rust/90'
          }`}
        >
          ⌖ Analyze Chapters
        </button>
      )}
      {metaOnly && (
        <p className="mt-1.5 text-xs text-center text-ink-dim">Re-upload EPUB to analyze</p>
      )}
      {!busy && !metaOnly && lastAnalyzedIndex !== null && lastAnalyzedIndex >= 0 && lastAnalyzedIndex < currentIndex && (
        <p className="mt-1.5 text-xs text-center text-ink-dim">Ch.{lastAnalyzedIndex + 2}–{currentIndex + 1} · chapter by chapter</p>
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
              busy ? 'border-border/50 text-ink-dim/40 cursor-not-allowed' : 'border-border text-ink-dim hover:text-ink hover:border-ink-dim'
            }`}
          >
            Rebuild from scratch
          </button>
        )}
        {!busy && <p className="mt-1 text-xs text-center text-ink-dim/50">Re-analyze ch.1–{currentIndex + 1} from scratch</p>}
      </div>

      {/* Analysis range */}
      {onSetRange && (
        <div className="mt-3 p-2.5 rounded-lg border border-border bg-paper space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold text-ink-dim uppercase tracking-wider">Analysis range</p>
            {chapterRange && (
              <button
                onClick={() => onSetRange(null)}
                className="text-[10px] text-ink-dim hover:text-danger transition-colors"
                title="Clear range"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="text-amber">⌞</span>
            <span className="truncate flex-1 min-w-0">
              {rangeStart !== undefined
                ? (normalizeTitle(chapters[rangeStart]?.title ?? '') || `Ch. ${rangeStart + 1}`)
                : <span className="text-ink-dim/50 italic">First chapter</span>}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="text-amber">⌟</span>
            <span className="truncate flex-1 min-w-0">
              {rangeEnd !== undefined
                ? (normalizeTitle(chapters[rangeEnd]?.title ?? '') || `Ch. ${rangeEnd + 1}`)
                : <span className="text-ink-dim/50 italic">Last chapter</span>}
            </span>
          </div>
          <p className="text-[10px] text-ink-dim/50">Hover a chapter below to set ⌞ start or ⌟ end</p>
          {onProcessBook && chapterRange && (
            <button
              onClick={onProcessBook}
              disabled={busy}
              className={`w-full mt-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                busy
                  ? 'bg-paper-dark text-ink-dim/40 cursor-not-allowed'
                  : 'bg-amber-500/15 text-amber hover:bg-amber-500/25 border border-amber-500/30'
              }`}
            >
              ⌖ Process entire book
            </button>
          )}
        </div>
      )}

      {/* Chapter list */}
      <div className="mt-5 flex-1 overflow-y-auto">
        <p className="text-xs font-medium text-ink-dim uppercase tracking-wider mb-2">Chapters</p>

        {isOmnibus ? (
          // If both range boundaries fall within the same book group, promote its
          // chapters to a clean flat list and hide all other groups.
          (() => {
            const focusedGroup = (rangeStart !== undefined && rangeEnd !== undefined)
              ? [...bookGroups.entries()].find(([, { items }]) => {
                  const indices = items.map((it) => it.globalIndex);
                  return indices.includes(rangeStart) && indices.includes(rangeEnd);
                })
              : undefined;

            if (focusedGroup) {
              const [, { items }] = focusedGroup;
              const visibleItems = items.filter(({ globalIndex }) =>
                (rangeStart === undefined || globalIndex >= rangeStart) &&
                (rangeEnd === undefined || globalIndex <= rangeEnd),
              );
              return (
                <ul className="space-y-0.5">
                  {visibleItems.map(({ ch, globalIndex }) => (
                    <ChapterItem key={ch.id} ch={ch} globalIndex={globalIndex} isExcluded={false} isRangeStart={rangeStart === globalIndex} isRangeEnd={rangeEnd === globalIndex} {...itemProps} />
                  ))}
                </ul>
              );
            }

            return (
          <ul className="space-y-1.5">
            {[...bookGroups.entries()].map(([bookIdx, { bookTitle, items }]) => {
              const rangeFilteredItems = items.filter(({ globalIndex }) =>
                (rangeStart === undefined || globalIndex >= rangeStart) &&
                (rangeEnd === undefined || globalIndex <= rangeEnd),
              );
              if (rangeFilteredItems.length === 0) return null;
              const isExpanded = expandedBooks.has(bookIdx);
              const analyzedCount = rangeFilteredItems.filter(({ globalIndex }) =>
                lastAnalyzedIndex !== null && globalIndex <= lastAnalyzedIndex,
              ).length;
              const isCurrent = rangeFilteredItems.some(({ globalIndex }) => globalIndex === currentIndex);

              return (
                <li key={bookIdx}>
                  {/* Book header */}
                  <div className={`flex items-center rounded-lg border transition-colors ${
                    isCurrent
                      ? 'border-amber-500/20 bg-amber-500/5'
                      : 'border-border bg-paper/20 hover:bg-paper/40'
                  }`}>
                    <button
                      onClick={() => toggleExpand(bookIdx)}
                      className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0"
                    >
                      <span className={`flex-shrink-0 text-[10px] ${isExpanded ? 'text-ink-soft' : 'text-ink-dim'}`}>
                        {isExpanded ? '▾' : '▸'}
                      </span>
                      <span className={`text-xs font-semibold truncate font-serif ${isCurrent ? 'text-amber/80' : 'text-ink-soft'}`}>
                        {bookTitle}
                      </span>
                    </button>
                    <div className="flex items-center gap-1.5 pr-2 flex-shrink-0">
                      <span className="text-[10px] text-ink-dim">
                        {analyzedCount > 0 ? `${analyzedCount}/${items.length}` : `${items.length} ch.`}
                      </span>
                    </div>
                  </div>

                  {/* Chapters (expanded) */}
                  {isExpanded && (
                    <ul className="mt-0.5 ml-2 space-y-0.5 border-l border-border pl-2">
                      {rangeFilteredItems.map(({ ch, globalIndex }) => (
                        <ChapterItem key={ch.id} ch={ch} globalIndex={globalIndex} isExcluded={false} isRangeStart={rangeStart === globalIndex} isRangeEnd={rangeEnd === globalIndex} {...itemProps} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
            );
          })()
        ) : (
          /* Flat list for non-omnibus */
          <ul className="space-y-0.5">
            {chapters.map((ch, i) => {
              if (visibleChapterOrders && !visibleChapterOrders.has(i)) return null;
              if (rangeStart !== undefined && i < rangeStart) return null;
              if (rangeEnd !== undefined && i > rangeEnd) return null;
              return <ChapterItem key={ch.id} ch={ch} globalIndex={i} isExcluded={false} isRangeStart={rangeStart === i} isRangeEnd={rangeEnd === i} {...itemProps} />;
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
