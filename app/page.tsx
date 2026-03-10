'use client';

import { useCallback, useRef, useState } from 'react';
import { parseEpub } from '@/lib/epub-parser';
import type { AnalysisResult, Character, ParsedEbook, Snapshot } from '@/types';
import CalibreLibrary from '@/components/CalibreLibrary';
import CharacterCard from '@/components/CharacterCard';
import ChapterSelector from '@/components/ChapterSelector';
import LocationBoard from '@/components/LocationBoard';
import SeriesPicker from '@/components/SeriesPicker';
import UploadZone from '@/components/UploadZone';

type SortKey = 'importance' | 'name' | 'status';
type MainTab = 'characters' | 'locations';

const IMPORTANCE_ORDER: Record<Character['importance'], number> = {
  main: 0,
  secondary: 1,
  minor: 2,
};

interface StoredBookState {
  lastAnalyzedIndex: number; // -1 = series carry-forward
  result: AnalysisResult;
  snapshots: Snapshot[];
}

interface SavedBookEntry {
  title: string;
  author: string;
  lastAnalyzedIndex: number;
}

function storageKey(title: string, author: string) {
  return `ebook-tracker::${title}::${author}`;
}

function loadStored(title: string, author: string): StoredBookState | null {
  try {
    const raw = localStorage.getItem(storageKey(title, author));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBookState;
    // Back-compat: old saves without snapshots
    if (!parsed.snapshots) parsed.snapshots = [];
    return parsed;
  } catch {
    return null;
  }
}

function saveStored(title: string, author: string, state: StoredBookState) {
  try {
    localStorage.setItem(storageKey(title, author), JSON.stringify(state));
  } catch { /* ignore */ }
}

/** Find the snapshot with the highest index ≤ targetIndex */
function bestSnapshot(snapshots: Snapshot[], targetIndex: number): Snapshot | null {
  let best: Snapshot | null = null;
  for (const s of snapshots) {
    if (s.index <= targetIndex && (best === null || s.index > best.index)) best = s;
  }
  return best;
}

/** Add/replace a snapshot for this index */
function upsertSnapshot(snapshots: Snapshot[], index: number, result: AnalysisResult): Snapshot[] {
  const without = snapshots.filter((s) => s.index !== index);
  return [...without, { index, result }];
}

function listSavedBooks(excludeTitle: string, excludeAuthor: string): SavedBookEntry[] {
  const results: SavedBookEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('ebook-tracker::')) continue;
      const [, title, author] = key.split('::');
      if (title === excludeTitle && author === excludeAuthor) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = JSON.parse(raw) as StoredBookState;
      if (state.lastAnalyzedIndex >= 0) results.push({ title, author, lastAnalyzedIndex: state.lastAnalyzedIndex });
    }
  } catch { /* ignore */ }
  return results;
}

async function analyzeChapter(
  bookTitle: string,
  bookAuthor: string,
  chapter: { title: string; text: string },
  previousResult: AnalysisResult | null,
): Promise<AnalysisResult> {
  const body = previousResult
    ? { newChapters: [chapter], previousResult, currentChapterTitle: chapter.title, bookTitle, bookAuthor }
    : { chaptersRead: [chapter], currentChapterTitle: chapter.title, bookTitle, bookAuthor };

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Analysis failed.');
  return data as AnalysisResult;
}

export default function Home() {
  const [book, setBook] = useState<ParsedEbook | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const [pendingBook, setPendingBook] = useState<ParsedEbook | null>(null);
  const [seriesOptions, setSeriesOptions] = useState<SavedBookEntry[]>([]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  // Which chapter index the currently displayed result corresponds to (null = latest)
  const [viewingSnapshotIndex, setViewingSnapshotIndex] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<'full' | 'incremental' | null>(null);

  const [uploadTab, setUploadTab] = useState<'file' | 'calibre'>('file');

  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{ current: number; total: number } | null>(null);
  const rebuildCancelRef = useRef(false);

  const [excludedBooks, setExcludedBooks] = useState<Set<number>>(new Set());

  function toggleBook(bookIndex: number) {
    setExcludedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookIndex)) next.delete(bookIndex); else next.add(bookIndex);
      return next;
    });
  }

  const [tab, setTab] = useState<MainTab>('characters');
  const [sortKey, setSortKey] = useState<SortKey>('importance');
  const [filter, setFilter] = useState<Character['importance'] | 'all'>('all');
  const [search, setSearch] = useState('');

  const storedRef = useRef<StoredBookState | null>(null);
  const seriesBaseRef = useRef<AnalysisResult | null>(null);

  function activateBook(parsed: ParsedEbook, initialStored: StoredBookState | null) {
    storedRef.current = initialStored;
    seriesBaseRef.current = initialStored?.lastAnalyzedIndex === -1 ? initialStored.result : null;
    setExcludedBooks(new Set());
    setBook(parsed);
    setViewingSnapshotIndex(null);
    setCurrentIndex(0);
    if (initialStored && initialStored.lastAnalyzedIndex >= 0) {
      setResult(initialStored.result);
      setCurrentIndex(initialStored.lastAnalyzedIndex);
    }
  }

  /** Called whenever the user selects a chapter in the sidebar */
  function handleChapterChange(i: number) {
    setCurrentIndex(i);
    const stored = storedRef.current;
    if (!stored || stored.lastAnalyzedIndex < 0) return;

    if (i >= stored.lastAnalyzedIndex) {
      // At or beyond the latest analyzed chapter — show the latest result
      setResult(stored.result);
      setViewingSnapshotIndex(null);
    } else {
      // Earlier chapter — look up nearest snapshot
      const snap = bestSnapshot(stored.snapshots, i);
      if (snap) {
        setResult(snap.result);
        setViewingSnapshotIndex(snap.index);
      }
      // If no snapshot exists yet for this range, keep the current display
    }
  }

  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setParseError(null);
    setBook(null);
    setPendingBook(null);
    setSeriesOptions([]);
    setResult(null);
    storedRef.current = null;
    seriesBaseRef.current = null;
    try {
      const parsed = await parseEpub(file);
      const ownStored = loadStored(parsed.title, parsed.author);
      if (ownStored) { activateBook(parsed, ownStored); return; }
      const others = listSavedBooks(parsed.title, parsed.author);
      if (others.length > 0) {
        setPendingBook(parsed);
        setSeriesOptions(others);
      } else {
        activateBook(parsed, null);
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse EPUB.');
    } finally {
      setParsing(false);
    }
  }, []);

  function handleContinueFrom(prevTitle: string, prevAuthor: string) {
    if (!pendingBook) return;
    const prevStored = loadStored(prevTitle, prevAuthor);
    if (!prevStored) { activateBook(pendingBook, null); return; }
    const carried: StoredBookState = { lastAnalyzedIndex: -1, result: prevStored.result, snapshots: [] };
    setPendingBook(null);
    setSeriesOptions([]);
    activateBook(pendingBook, carried);
  }

  function handleStartFresh() {
    if (!pendingBook) return;
    setPendingBook(null);
    setSeriesOptions([]);
    activateBook(pendingBook, null);
  }

  const handleAnalyze = useCallback(async () => {
    if (!book) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalysisMode(null);

    try {
      const stored = storedRef.current;
      const canIncrement = stored && currentIndex > stored.lastAnalyzedIndex;
      let body: Record<string, unknown>;

      const included = (ch: typeof book.chapters[0]) =>
        ch.bookIndex === undefined || !excludedBooks.has(ch.bookIndex);

      if (canIncrement) {
        const fromIndex = stored.lastAnalyzedIndex + 1;
        const newChapters = book.chapters.slice(fromIndex, currentIndex + 1).filter(included).map((ch) => ({ title: ch.title, text: ch.text }));
        body = { newChapters, previousResult: stored.result, currentChapterTitle: book.chapters[currentIndex].title, bookTitle: book.title, bookAuthor: book.author };
        setAnalysisMode('incremental');
      } else {
        const chaptersRead = book.chapters.slice(0, currentIndex + 1).filter(included).map((ch) => ({ title: ch.title, text: ch.text }));
        body = { chaptersRead, currentChapterTitle: book.chapters[currentIndex].title, bookTitle: book.title, bookAuthor: book.author };
        setAnalysisMode('full');
      }

      const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed.');

      const newResult = data as AnalysisResult;
      setResult(newResult);
      setViewingSnapshotIndex(null);

      const prevSnapshots = storedRef.current?.snapshots ?? [];
      const newStored: StoredBookState = {
        lastAnalyzedIndex: currentIndex,
        result: newResult,
        snapshots: upsertSnapshot(prevSnapshots, currentIndex, newResult),
      };
      storedRef.current = newStored;
      saveStored(book.title, book.author, newStored);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      setAnalyzing(false);
    }
  }, [book, currentIndex]);

  const handleRebuild = useCallback(async () => {
    if (!book) return;
    rebuildCancelRef.current = false;
    setRebuilding(true);
    setAnalyzeError(null);
    setRebuildProgress({ current: 0, total: currentIndex + 1 });

    let accumulated: AnalysisResult | null = seriesBaseRef.current;
    let snapshots: Snapshot[] = storedRef.current?.snapshots ?? [];

    try {
      for (let i = 0; i <= currentIndex; i++) {
        if (rebuildCancelRef.current) break;
        setRebuildProgress({ current: i + 1, total: currentIndex + 1 });
        const ch = book.chapters[i];
        if (ch.bookIndex !== undefined && excludedBooks.has(ch.bookIndex)) continue;
        const chapter = { title: ch.title, text: ch.text };
        accumulated = await analyzeChapter(book.title, book.author, chapter, accumulated);
        snapshots = upsertSnapshot(snapshots, i, accumulated);
        const partial: StoredBookState = { lastAnalyzedIndex: i, result: accumulated, snapshots };
        storedRef.current = partial;
        saveStored(book.title, book.author, partial);
        setResult(accumulated);
        setViewingSnapshotIndex(null);
      }
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Rebuild failed.');
    } finally {
      setRebuilding(false);
      setRebuildProgress(null);
      rebuildCancelRef.current = false;
    }
  }, [book, currentIndex]);

  const characters = result?.characters ?? [];
  const displayed = characters
    .filter((c) => {
      if (filter !== 'all' && c.importance !== filter) return false;
      if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === 'importance') return IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance];
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      if (sortKey === 'status') return a.status.localeCompare(b.status);
      return 0;
    });

  if (pendingBook) {
    return (
      <main className="min-h-screen">
        <SeriesPicker
          newBookTitle={pendingBook.title}
          newBookAuthor={pendingBook.author}
          savedBooks={seriesOptions}
          onContinueFrom={handleContinueFrom}
          onStartFresh={handleStartFresh}
        />
      </main>
    );
  }

  if (!book) {
    return (
      <main className="min-h-screen flex flex-col">
        <div className="flex border-b border-zinc-800 px-6 pt-6 gap-1">
          {([
            { key: 'file', label: 'Upload EPUB' },
            { key: 'calibre', label: 'Calibre Library' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setUploadTab(key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors -mb-px ${
                uploadTab === key
                  ? 'border-amber-500 text-amber-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 p-6">
          {uploadTab === 'file' ? (
            <>
              <UploadZone onFile={handleFile} parsing={parsing} />
              {parseError && <p className="mt-4 text-center text-red-500 text-sm">{parseError}</p>}
            </>
          ) : (
            <CalibreLibrary onFile={handleFile} />
          )}
        </div>
      </main>
    );
  }

  const stored = storedRef.current;
  const hasStoredState = !!stored && stored.lastAnalyzedIndex >= 0;
  const isSeriesContinuation = stored?.lastAnalyzedIndex === -1;
  const canIncrement = stored && currentIndex > stored.lastAnalyzedIndex;
  const busy = analyzing || rebuilding;
  const snapshotIndices = new Set((stored?.snapshots ?? []).map((s) => s.index));
  // Whether the displayed result is from a historical snapshot rather than the latest
  const isViewingHistory = viewingSnapshotIndex !== null;

  return (
    <main className="min-h-screen flex flex-col">
      <header className="bg-zinc-900 border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl">📖</span>
          <div>
            <h1 className="font-bold text-zinc-100 leading-tight">{book.title}</h1>
            <p className="text-xs text-zinc-500">{book.author}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isSeriesContinuation && <span className="text-xs text-violet-400 font-medium">Series mode</span>}
          {hasStoredState && (
            <span className="text-xs text-zinc-600">Saved · ch.{stored.lastAnalyzedIndex + 1}</span>
          )}
          <button
            onClick={() => { setBook(null); setResult(null); storedRef.current = null; seriesBaseRef.current = null; }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Change book
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-64 flex-shrink-0 bg-zinc-900 border-r border-zinc-800 p-4 overflow-y-auto">
          <ChapterSelector
            chapters={book.chapters}
            currentIndex={currentIndex}
            onChange={handleChapterChange}
            onAnalyze={handleAnalyze}
            onRebuild={handleRebuild}
            onCancelRebuild={() => { rebuildCancelRef.current = true; }}
            analyzing={analyzing}
            rebuilding={rebuilding}
            rebuildProgress={rebuildProgress}
            canIncrement={!!canIncrement}
            lastAnalyzedIndex={stored?.lastAnalyzedIndex ?? null}
            snapshotIndices={snapshotIndices}
            excludedBooks={excludedBooks}
            onToggleBook={toggleBook}
          />
          {analyzeError && <p className="mt-3 text-xs text-red-500 text-center">{analyzeError}</p>}
        </aside>

        <div className="flex-1 overflow-y-auto p-6">
          {/* History banner */}
          {isViewingHistory && !busy && (
            <div className="mb-4 flex items-center justify-between px-4 py-2.5 bg-zinc-800/60 rounded-xl border border-zinc-700/50">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">
                  Viewing saved state from <span className="text-zinc-200 font-medium">ch.{viewingSnapshotIndex + 1} — {book.chapters[viewingSnapshotIndex]?.title}</span>
                </span>
              </div>
              <button
                onClick={() => {
                  if (stored && stored.lastAnalyzedIndex >= 0) {
                    setCurrentIndex(stored.lastAnalyzedIndex);
                    setResult(stored.result);
                    setViewingSnapshotIndex(null);
                  }
                }}
                className="text-xs text-amber-500 hover:text-amber-400 font-medium transition-colors whitespace-nowrap ml-4"
              >
                Jump to latest →
              </button>
            </div>
          )}

          {!result && !busy && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3">
              <span className="text-5xl opacity-20">{isSeriesContinuation ? '📚' : '⌖'}</span>
              <p className="text-zinc-400 font-medium">
                {isSeriesContinuation
                  ? 'Series characters loaded. Select a chapter and update.'
                  : 'Select your chapter and analyze.'}
              </p>
              <p className="text-sm text-zinc-600 max-w-xs">
                {isSeriesContinuation
                  ? 'Only new chapters will be read — your existing characters carry forward.'
                  : "Only what you've read is sent to the model — no spoilers."}
              </p>
            </div>
          )}

          {analyzing && !rebuilding && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-10 h-10 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-zinc-300 font-medium">
                {analysisMode === 'incremental' ? 'Updating characters…' : 'Analyzing…'}
              </p>
              <p className="text-sm text-zinc-600">
                {analysisMode === 'incremental' ? 'New chapters only — existing roster preserved' : 'Extracting characters without spoilers'}
              </p>
            </div>
          )}

          {rebuilding && rebuildProgress && (
            <div className="flex flex-col items-center justify-center h-full gap-5">
              <div className="w-10 h-10 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-zinc-200 font-semibold">Rebuilding…</p>
                <p className="text-sm text-zinc-500 mt-1">
                  Chapter {rebuildProgress.current} / {rebuildProgress.total}
                  {' · '}<span className="text-zinc-400">{book.chapters[rebuildProgress.current - 1]?.title}</span>
                </p>
              </div>
              <div className="w-56 bg-zinc-800 rounded-full h-1">
                <div
                  className="bg-violet-500 h-1 rounded-full transition-all duration-300"
                  style={{ width: `${(rebuildProgress.current / rebuildProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-zinc-700">Results update live · cancel anytime</p>
            </div>
          )}

          {result && (
            <div>
              {result.summary && (
                <div className="mb-5 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                  <p className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">Story so far</p>
                  <p className="text-sm text-zinc-400 leading-relaxed">{result.summary}</p>
                </div>
              )}

              <div className="flex rounded-lg overflow-hidden border border-zinc-800 mb-5 w-fit">
                {([
                  { key: 'characters', label: 'Characters' },
                  { key: 'locations', label: 'Locations' },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`px-5 py-2 text-sm font-medium transition-colors ${
                      tab === key ? 'bg-zinc-700 text-zinc-100' : 'bg-transparent text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'characters' && (
                <>
                  <div className="flex flex-wrap items-center gap-2 mb-4">
                    <input
                      type="search"
                      placeholder="Search…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 min-w-36 flex-1"
                    />
                    <div className="flex gap-1.5">
                      {(['all', 'main', 'secondary', 'minor'] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setFilter(f)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            filter === f
                              ? 'bg-zinc-700 text-zinc-100'
                              : 'text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          {f.charAt(0).toUpperCase() + f.slice(1)}
                        </button>
                      ))}
                    </div>
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-500 focus:outline-none focus:border-zinc-600"
                    >
                      <option value="importance">Importance</option>
                      <option value="name">Name</option>
                      <option value="status">Status</option>
                    </select>
                  </div>

                  <div className="flex gap-4 mb-4 text-xs text-zinc-600">
                    <span>{characters.length} characters</span>
                    <span>·</span>
                    <span>{characters.filter((c) => c.status === 'alive').length} alive</span>
                    <span>·</span>
                    <span>{characters.filter((c) => c.status === 'dead').length} dead</span>
                    <span>·</span>
                    <span>{characters.filter((c) => c.importance === 'main').length} main</span>
                  </div>

                  {displayed.length === 0 ? (
                    <p className="text-center text-zinc-600 py-12">No characters match.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {displayed.map((character) => (
                        <CharacterCard
                          key={character.name}
                          character={character}
                          snapshots={stored?.snapshots ?? []}
                          chapterTitles={book.chapters.map((ch) => ch.title)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab === 'locations' && (
                <LocationBoard characters={characters} bookTitle={book.title} />
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
