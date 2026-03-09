'use client';

import { useCallback, useRef, useState } from 'react';
import { parseEpub } from '@/lib/epub-parser';
import type { AnalysisResult, Character, ParsedEbook } from '@/types';
import CharacterCard from '@/components/CharacterCard';
import ChapterSelector from '@/components/ChapterSelector';
import LocationBoard from '@/components/LocationBoard';
import UploadZone from '@/components/UploadZone';

type SortKey = 'importance' | 'name' | 'status';
type MainTab = 'characters' | 'locations';

const IMPORTANCE_ORDER: Record<Character['importance'], number> = {
  main: 0,
  secondary: 1,
  minor: 2,
};

interface StoredBookState {
  lastAnalyzedIndex: number;
  result: AnalysisResult;
}

function storageKey(title: string, author: string) {
  return `ebook-tracker::${title}::${author}`;
}

function loadStored(title: string, author: string): StoredBookState | null {
  try {
    const raw = localStorage.getItem(storageKey(title, author));
    return raw ? (JSON.parse(raw) as StoredBookState) : null;
  } catch {
    return null;
  }
}

function saveStored(title: string, author: string, state: StoredBookState) {
  try {
    localStorage.setItem(storageKey(title, author), JSON.stringify(state));
  } catch {
    // storage full or unavailable — silently ignore
  }
}

async function analyzeChapter(
  bookTitle: string,
  bookAuthor: string,
  chapter: { title: string; text: string },
  previousResult: AnalysisResult | null,
): Promise<AnalysisResult> {
  const body = previousResult
    ? {
        newChapters: [chapter],
        previousResult,
        currentChapterTitle: chapter.title,
        bookTitle,
        bookAuthor,
      }
    : {
        chaptersRead: [chapter],
        currentChapterTitle: chapter.title,
        bookTitle,
        bookAuthor,
      };

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

  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<'full' | 'incremental' | null>(null);

  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{ current: number; total: number } | null>(null);
  const rebuildCancelRef = useRef(false);

  const [tab, setTab] = useState<MainTab>('characters');
  const [sortKey, setSortKey] = useState<SortKey>('importance');
  const [filter, setFilter] = useState<Character['importance'] | 'all'>('all');
  const [search, setSearch] = useState('');

  // Tracks stored state for the currently loaded book
  const storedRef = useRef<StoredBookState | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setParseError(null);
    setBook(null);
    setResult(null);
    storedRef.current = null;
    try {
      const parsed = await parseEpub(file);
      setBook(parsed);
      setCurrentIndex(0);
      const stored = loadStored(parsed.title, parsed.author);
      storedRef.current = stored;
      if (stored) {
        setResult(stored.result);
        setCurrentIndex(stored.lastAnalyzedIndex);
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse EPUB.');
    } finally {
      setParsing(false);
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!book) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalysisMode(null);

    try {
      const stored = storedRef.current;
      const canIncrement = stored && currentIndex > stored.lastAnalyzedIndex;

      let body: Record<string, unknown>;

      if (canIncrement) {
        const newChapters = book.chapters
          .slice(stored.lastAnalyzedIndex + 1, currentIndex + 1)
          .map((ch) => ({ title: ch.title, text: ch.text }));
        body = {
          newChapters,
          previousResult: stored.result,
          currentChapterTitle: book.chapters[currentIndex].title,
          bookTitle: book.title,
          bookAuthor: book.author,
        };
        setAnalysisMode('incremental');
      } else {
        const chaptersRead = book.chapters
          .slice(0, currentIndex + 1)
          .map((ch) => ({ title: ch.title, text: ch.text }));
        body = {
          chaptersRead,
          currentChapterTitle: book.chapters[currentIndex].title,
          bookTitle: book.title,
          bookAuthor: book.author,
        };
        setAnalysisMode('full');
      }

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed.');

      const newResult = data as AnalysisResult;
      setResult(newResult);

      const newStored: StoredBookState = { lastAnalyzedIndex: currentIndex, result: newResult };
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

    let accumulated: AnalysisResult | null = null;
    try {
      for (let i = 0; i <= currentIndex; i++) {
        if (rebuildCancelRef.current) break;
        setRebuildProgress({ current: i + 1, total: currentIndex + 1 });

        const chapter = { title: book.chapters[i].title, text: book.chapters[i].text };
        accumulated = await analyzeChapter(book.title, book.author, chapter, accumulated);

        // Save intermediate progress so a cancel still has a useful partial result
        const partial: StoredBookState = { lastAnalyzedIndex: i, result: accumulated };
        storedRef.current = partial;
        saveStored(book.title, book.author, partial);
        setResult(accumulated);
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

  if (!book) {
    return (
      <main className="min-h-screen p-6">
        <UploadZone onFile={handleFile} parsing={parsing} />
        {parseError && (
          <p className="mt-4 text-center text-red-600 text-sm">{parseError}</p>
        )}
      </main>
    );
  }

  const stored = storedRef.current;
  const hasStoredState = !!stored;
  const canIncrement = stored && currentIndex > stored.lastAnalyzedIndex;
  const busy = analyzing || rebuilding;

  return (
    <main className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-amber-100 px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📖</span>
          <div>
            <h1 className="font-serif font-bold text-amber-900 leading-tight">{book.title}</h1>
            <p className="text-xs text-amber-600">{book.author}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {hasStoredState && (
            <span className="text-xs text-amber-400">
              Progress saved · last analyzed ch.{stored.lastAnalyzedIndex + 1}
            </span>
          )}
          <button
            onClick={() => { setBook(null); setResult(null); storedRef.current = null; }}
            className="text-xs text-amber-500 hover:text-amber-700 underline underline-offset-2"
          >
            Load different book
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside className="w-72 flex-shrink-0 bg-white border-r border-amber-100 p-4 overflow-y-auto">
          <ChapterSelector
            chapters={book.chapters}
            currentIndex={currentIndex}
            onChange={(i) => { setCurrentIndex(i); }}
            onAnalyze={handleAnalyze}
            onRebuild={handleRebuild}
            onCancelRebuild={() => { rebuildCancelRef.current = true; }}
            analyzing={analyzing}
            rebuilding={rebuilding}
            rebuildProgress={rebuildProgress}
            canIncrement={!!canIncrement}
            lastAnalyzedIndex={stored?.lastAnalyzedIndex ?? null}
          />
          {analyzeError && (
            <p className="mt-3 text-xs text-red-500 text-center">{analyzeError}</p>
          )}
        </aside>

        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!result && !busy && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4">
              <span className="text-6xl">🔍</span>
              <p className="text-lg font-medium text-amber-600">
                Select your current chapter and click <strong>Analyze Characters</strong>
              </p>
              <p className="text-sm text-amber-400 max-w-xs">
                Claude will only read what you&apos;ve read so far — zero spoilers.
              </p>
            </div>
          )}

          {analyzing && !rebuilding && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-14 h-14 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-amber-700 font-medium">
                {analysisMode === 'incremental'
                  ? <>Updating to <em>{book.chapters[currentIndex]?.title}</em>…</>
                  : <>Reading up to <em>{book.chapters[currentIndex]?.title}</em>…</>
                }
              </p>
              <p className="text-sm text-amber-400">
                {analysisMode === 'incremental'
                  ? 'Only reading new chapters — all previous characters preserved'
                  : 'Extracting characters without spoilers'}
              </p>
            </div>
          )}

          {rebuilding && rebuildProgress && (
            <div className="flex flex-col items-center justify-center h-full gap-5">
              <div className="w-14 h-14 border-4 border-violet-400 border-t-transparent rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-violet-700 font-semibold text-lg">
                  Rebuilding dataset…
                </p>
                <p className="text-sm text-violet-500 mt-1">
                  Chapter {rebuildProgress.current} of {rebuildProgress.total}
                  {' '}· <em>{book.chapters[rebuildProgress.current - 1]?.title}</em>
                </p>
              </div>
              {/* Progress bar */}
              <div className="w-64 bg-violet-100 rounded-full h-2">
                <div
                  className="bg-violet-400 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(rebuildProgress.current / rebuildProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-violet-400">
                Results update live · you can cancel at any time
              </p>
            </div>
          )}

          {result && (
            <div>
              {/* Story summary */}
              {result.summary && (
                <div className="mb-5 p-4 bg-white rounded-2xl border border-amber-100 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-500 mb-1">
                    Story so far
                  </p>
                  <p className="text-sm text-stone-700 leading-relaxed">{result.summary}</p>
                </div>
              )}

              {/* Tab switcher */}
              <div className="flex rounded-xl overflow-hidden border border-amber-200 mb-5 w-fit">
                {([
                  { key: 'characters', label: '👥 Characters' },
                  { key: 'locations', label: '🗺️ Locations' },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`px-5 py-2 text-sm font-semibold transition-colors ${
                      tab === key
                        ? 'bg-amber-500 text-white'
                        : 'bg-white text-amber-600 hover:bg-amber-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'characters' && (
                <>
                  <div className="flex flex-wrap items-center gap-3 mb-4">
                    <div className="flex-1 min-w-36">
                      <input
                        type="search"
                        placeholder="Search characters…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-white border border-stone-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                      />
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {(['all', 'main', 'secondary', 'minor'] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setFilter(f)}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                            filter === f
                              ? 'bg-amber-500 text-white'
                              : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-50'
                          }`}
                        >
                          {f.charAt(0).toUpperCase() + f.slice(1)}
                        </button>
                      ))}
                    </div>
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="bg-white border border-stone-200 rounded-xl px-3 py-2 text-xs text-stone-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    >
                      <option value="importance">Sort: Importance</option>
                      <option value="name">Sort: Name</option>
                      <option value="status">Sort: Status</option>
                    </select>
                  </div>

                  <div className="flex gap-4 mb-4 text-xs text-stone-500">
                    <span>{characters.length} characters</span>
                    <span>•</span>
                    <span>{characters.filter((c) => c.status === 'alive').length} alive</span>
                    <span>•</span>
                    <span>{characters.filter((c) => c.status === 'dead').length} dead</span>
                    <span>•</span>
                    <span>{characters.filter((c) => c.importance === 'main').length} main</span>
                  </div>

                  {displayed.length === 0 ? (
                    <p className="text-center text-stone-400 py-12">No characters match your filter.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {displayed.map((character) => (
                        <CharacterCard key={character.name} character={character} />
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
