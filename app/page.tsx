'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseEpub } from '@/lib/epub-parser';
import type { AnalysisResult, BookBuddyExport, BookFilter, BookMeta, ChapterEvent, Character, MapState, NarrativeArc, ParentArc, ParsedEbook, PinUpdates, QueueJob, ReadingPosition, SavedBookEntry, SeriesDefinition, Snapshot, StoredBookState } from '@/types';
import CalibreLibrary from '@/components/CalibreLibrary';
import CharacterCard from '@/components/CharacterCard';
import ChapterSelector from '@/components/ChapterSelector';
import LocationBoard from '@/components/LocationBoard';
import MapBoard from '@/components/MapBoard';
import SeriesPicker from '@/components/SeriesPicker';
import SettingsModal from '@/components/SettingsModal';
import GithubLibrary from '@/components/GithubLibrary';
import UploadZone from '@/components/UploadZone';
import { normalizeTitle } from '@/lib/normalize-title';
import { saveChapters, loadChapters } from '@/lib/chapter-storage';
import { listSavedBooks, loadBookState, saveBookState, deleteBookState, loadBookMapState, saveBookMapState, migrateFromLocalStorage, onCrossTabSync } from '@/lib/book-storage';
import ProcessingQueue from '@/components/ProcessingQueue';
import ChatPanel from '@/components/ChatPanel';
import ArcsPanel from '@/components/ArcsPanel';
import EntityManager from '@/components/EntityManager';
import { buildShareMarkdown, shareReadingContext } from '@/lib/share-context';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import StoryTimeline from '@/components/StoryTimeline';
import WelcomeBanner from '@/components/WelcomeBanner';
import LibrarySubmitModal from '@/components/LibrarySubmitModal';
import BookmarkModal from '@/components/BookmarkModal';
import BookStructureEditor from '@/components/BookStructureEditor';
import BookFilterSelector from '@/components/BookFilterSelector';
import { useDerivedEntities } from '@/lib/use-derived-entities';
import { buildInitialSeriesDefinition, migrateToSeriesDefinition, getActiveParentArcs, getStaleBooks, computeArcGroupingHash } from '@/lib/series';
import { generateParentArcs, generateSeriesArcs } from '@/lib/generate-arcs';
import SearchFAB from '@/components/SearchFAB';
import SearchSheet from '@/components/SearchSheet';
import CharacterModal from '@/components/CharacterModal';
import LocationModal from '@/components/LocationModal';
import NarrativeArcModal from '@/components/NarrativeArcModal';
import ExploreHeader from '@/components/explore/ExploreHeader';
import BottomNav from '@/components/explore/BottomNav';
import PullUpSheet from '@/components/explore/PullUpSheet';
import RecapStrip from '@/components/explore/RecapStrip';
import SnapshotNav from '@/components/explore/SnapshotNav';
import NewCharacterCard from '@/components/cards/CharacterCard';
import NewLocationCard from '@/components/cards/LocationCard';
import ArcCard from '@/components/cards/ArcCard';
import WorkshopScreen from '@/components/workshop/WorkshopScreen';

type SortKey = 'importance' | 'name' | 'status';
type MainTab = 'characters' | 'locations' | 'arcs' | 'map';

const IMPORTANCE_ORDER: Record<Character['importance'], number> = {
  main: 0,
  secondary: 1,
  minor: 2,
};

async function importBookBuddy(file: File): Promise<{ title: string; author: string }> {
  const text = await file.text();
  const payload = JSON.parse(text) as Partial<BookBuddyExport>;
  if (!payload.title || !payload.author || !payload.state) {
    throw new Error('Invalid or unrecognised .bookbuddy file.');
  }
  await saveBookState(payload.title, payload.author, payload.state);
  if (payload.mapState) await saveBookMapState(payload.title, payload.author, payload.mapState);
  return { title: payload.title, author: payload.author };
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
function upsertSnapshot(snapshots: Snapshot[], index: number, result: AnalysisResult, model?: string, appVersion?: string, events?: ChapterEvent[]): Snapshot[] {
  const without = snapshots.filter((s) => s.index !== index);
  return [...without, { index, result, ...(model ? { model } : {}), ...(appVersion ? { appVersion } : {}), ...(events?.length ? { events } : {}) }];
}

const IS_MOBILE = process.env.NEXT_PUBLIC_MOBILE === 'true';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

const FRONT_MATTER_RE = /^\s*(acknowledgements?|acknowledgments?|foreword|fore\s*word|preface|dedication|about\s+the\s+author|author'?s?\s+note|note\s+(from|by)\s+the\s+author|copyright|contents|table\s+of\s+contents|cast\s+of\s+characters|dramatis\s+personae|maps?|part\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|i{1,3}|iv|vi{0,3}|ix))\s*$/i;

function isFrontMatter(ch: { title: string; text: string }): boolean {
  return FRONT_MATTER_RE.test(ch.title) || ch.text.trim().length < 200;
}

const BACK_MATTER_RE = /^\s*(acknowledgements?|acknowledgments?|about\s+the\s+author|author'?s?\s+note|note\s+(from|by)\s+the\s+author|also\s+by|other\s+books|bibliography|glossary|appendix|afterword|bonus|excerpt|preview|sneak\s+peek|reading\s+group|book\s+club|discussion\s+questions?)\s*$/i;

function isBackMatter(ch: { title: string; text: string }): boolean {
  return BACK_MATTER_RE.test(ch.title) || ch.text.trim().length < 200;
}

function detectChapterRange(chapters: Array<{ title: string; text: string }>): { start: number; end: number } {
  let start = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (!isFrontMatter(chapters[i])) { start = i; break; }
  }
  let end = chapters.length - 1;
  for (let i = chapters.length - 1; i >= start; i--) {
    if (!isBackMatter(chapters[i])) { end = i; break; }
  }
  return { start, end };
}

async function analyzeChapter(
  bookTitle: string,
  bookAuthor: string,
  chapter: { title: string; text: string },
  previousResult: AnalysisResult | null,
  allChapterTitles?: string[],
): Promise<{ result: AnalysisResult; model: string; rateLimitWaitMs?: number; events?: ChapterEvent[] }> {
  if (IS_MOBILE) {
    const { analyzeChapterClient } = await import('@/lib/ai-client');
    const result = await analyzeChapterClient(bookTitle, bookAuthor, chapter, previousResult);
    return { result, model: 'mobile' };
  }

  // Include client-side AI settings so server can use them when env vars aren't set
  let aiSettings: Record<string, string | number> = {};
  try {
    const { loadAiSettings } = await import('@/lib/ai-client');
    const s = loadAiSettings();
    if (s.provider) aiSettings._provider = s.provider;
    if (s.anthropicKey) aiSettings._apiKey = s.anthropicKey;
    if (s.ollamaUrl) aiSettings._ollamaUrl = s.ollamaUrl;
    if (s.model) aiSettings._model = s.model;
    if (s.geminiKey) aiSettings._geminiKey = s.geminiKey;
    if (s.openaiCompatibleUrl) aiSettings._openaiCompatibleUrl = s.openaiCompatibleUrl;
    if (s.openaiCompatibleKey) aiSettings._openaiCompatibleKey = s.openaiCompatibleKey;
    if (s.ollamaContextLength) aiSettings._ollamaContextLength = s.ollamaContextLength;
  } catch { /* ignore — server will use env vars */ }

  const body = previousResult
    ? { newChapters: [chapter], previousResult, currentChapterTitle: chapter.title, bookTitle, bookAuthor, ...aiSettings }
    : { chaptersRead: [chapter], allChapterTitles, currentChapterTitle: chapter.title, bookTitle, bookAuthor, ...aiSettings };

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as AnalysisResult & { _model?: string; _rateLimitWaitMs?: number; _events?: ChapterEvent[] };
  if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? 'Analysis failed.');
  const { _model, _rateLimitWaitMs, _events, ...result } = data;
  return { result: result as AnalysisResult, model: _model ?? 'unknown', rateLimitWaitMs: _rateLimitWaitMs, events: _events };
}

async function reconcileResult(
  bookTitle: string,
  bookAuthor: string,
  result: AnalysisResult,
  recentChapterText?: string,
): Promise<AnalysisResult> {
  if (IS_MOBILE) {
    const { reconcileResultClient } = await import('@/lib/ai-client');
    return reconcileResultClient(bookTitle, bookAuthor, result, recentChapterText);
  }

  let aiSettings: Record<string, string> = {};
  try {
    const { loadAiSettings } = await import('@/lib/ai-client');
    const s = loadAiSettings();
    if (s.provider) aiSettings._provider = s.provider;
    if (s.anthropicKey) aiSettings._apiKey = s.anthropicKey;
    if (s.ollamaUrl) aiSettings._ollamaUrl = s.ollamaUrl;
    if (s.model) aiSettings._model = s.model;
    if (s.geminiKey) aiSettings._geminiKey = s.geminiKey;
    if (s.openaiCompatibleUrl) aiSettings._openaiCompatibleUrl = s.openaiCompatibleUrl;
    if (s.openaiCompatibleKey) aiSettings._openaiCompatibleKey = s.openaiCompatibleKey;
  } catch { /* ignore */ }

  const res = await fetch('/api/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      result, bookTitle, bookAuthor,
      chapterExcerpts: recentChapterText?.slice(0, 30_000),
      ...aiSettings,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Reconciliation failed.');
  return data as AnalysisResult;
}

/** Fire parent arc grouping if the book (or a specific book within a series) is fully analyzed. */
async function maybeGenerateParentArcs(
  stored: StoredBookState,
  bookTitle: string,
  bookAuthor: string,
  rangeEnd: number,
  cancelled: boolean,
): Promise<StoredBookState> {
  if (cancelled) return stored;
  if (stored.lastAnalyzedIndex < rangeEnd) return stored;
  if (!stored.result.arcs?.length) return stored;

  // If we have a series, do per-book grouping
  if (stored.series && stored.series.books.length > 1) {
    let series = { ...stored.series, books: [...stored.series.books] };
    let anyBookGrouped = false;

    for (let bi = 0; bi < series.books.length; bi++) {
      const bookDef = series.books[bi];
      // Check if all chapters in this book are analyzed
      const bookEnd = bookDef.chapterEnd;
      if (stored.lastAnalyzedIndex < bookEnd) continue;
      // Skip if already grouped and not stale
      const currentHash = computeArcGroupingHash(bookDef);
      if (bookDef.arcGroupingHash === currentHash && bookDef.parentArcs?.length) continue;

      // Gather arcs from snapshots within this book's range
      const bookSnapshots = stored.snapshots.filter(
        (s) => s.index >= bookDef.chapterStart && s.index <= bookDef.chapterEnd
          && !bookDef.excludedChapters.includes(s.index),
      );
      const lastSnap = bookSnapshots.sort((a, b) => b.index - a.index)[0];
      const bookArcs = lastSnap?.result.arcs ?? [];
      if (!bookArcs.length) continue;

      try {
        const parentArcs = await generateParentArcs(bookTitle, bookAuthor, bookArcs);
        series.books[bi] = {
          ...bookDef,
          parentArcs,
          arcGroupingHash: currentHash,
        };
        anyBookGrouped = true;
      } catch (e) {
        console.warn(`[parent-arcs] Per-book generation failed for "${bookDef.title}":`, e);
      }
    }

    let result = { ...stored, series };

    // If all books have per-book arcs, generate series-level arcs
    if (anyBookGrouped) {
      const booksWithArcs = series.books
        .filter((b) => b.parentArcs?.length)
        .map((b) => ({ bookTitle: b.title, parentArcs: b.parentArcs! }));
      if (booksWithArcs.length >= 2) {
        try {
          const seriesArcs = await generateSeriesArcs(bookTitle, bookAuthor, booksWithArcs);
          result = { ...result, series: { ...result.series!, seriesArcs } };
        } catch (e) {
          console.warn('[parent-arcs] Series-level generation failed:', e);
        }
      }
    }

    return result;
  }

  // Non-series fallback: original behavior
  try {
    const parentArcs = await generateParentArcs(bookTitle, bookAuthor, stored.result.arcs);
    return { ...stored, parentArcs };
  } catch (e) {
    console.warn('[parent-arcs] Generation failed:', e);
    return stored;
  }
}

function SetupPrompt({ onComplete, onOpenSettings }: { onComplete: () => void; onOpenSettings: () => void }) {
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);

  async function handleTestAndSave() {
    if (!key.trim()) return;
    setTesting(true);
    setError('');
    try {
      const { saveAiSettings, testConnection } = await import('@/lib/ai-client');
      const settings = {
        provider: 'gemini' as const,
        anthropicKey: '', ollamaUrl: 'http://localhost:11434/v1', model: 'gemini-2.0-flash',
        geminiKey: key.trim(),
        openaiCompatibleUrl: '', openaiCompatibleKey: '', openaiCompatibleName: '',
      };
      await testConnection(settings);
      saveAiSettings(settings);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 text-center gap-4 px-4">
      <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-6 max-w-md w-full space-y-4">
        <h3 className="font-bold text-stone-900 dark:text-zinc-100 text-sm">Set up an AI provider to analyze this book</h3>
        <div className="text-left space-y-2">
          <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">Recommended: Google Gemini (free)</p>
          <p className="text-xs text-stone-500 dark:text-zinc-400">Get a free API key in ~60 seconds — no credit card required.</p>
        </div>
        <button
          onClick={() => setGuideOpen(!guideOpen)}
          className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors w-full text-left"
        >
          {guideOpen ? '\u25be' : '\u25b8'} Step-by-step guide
        </button>
        {guideOpen && (
          <ol className="text-xs text-stone-500 dark:text-zinc-400 space-y-1 list-decimal list-inside text-left">
            <li>Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-amber-600 dark:text-amber-400 hover:underline">Google AI Studio</a></li>
            <li>Sign in with your Google account</li>
            <li>Click &quot;Create API Key&quot;</li>
            <li>Copy the key and paste it below</li>
          </ol>
        )}
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => { setKey(e.target.value); setError(''); }}
            placeholder="Paste Gemini API key"
            className="flex-1 bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
            onKeyDown={(e) => e.key === 'Enter' && handleTestAndSave()}
          />
          <button
            onClick={handleTestAndSave}
            disabled={testing || !key.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {testing ? 'Testing...' : 'Test & Save'}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          onClick={onOpenSettings}
          className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
        >
          Other providers
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  const [isDark, setIsDark] = useState(true);

  // Sync theme with <html class> and localStorage
  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const dark = stored !== 'light';
    setIsDark(dark);
    document.documentElement.classList.toggle('dark', dark);
  }, []);

  function toggleTheme() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  // --- IndexedDB migration (runs once) ---
  const [migrationDone, setMigrationDone] = useState(false);
  useEffect(() => { migrateFromLocalStorage().then(() => setMigrationDone(true)); }, []);

  // --- Save error surfacing ---
  const [saveError, setSaveError] = useState<string | null>(null);

  const [book, setBook] = useState<ParsedEbook | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const [pendingBook, setPendingBook] = useState<ParsedEbook | null>(null);
  const [seriesOptions, setSeriesOptions] = useState<SavedBookEntry[]>([]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  // Which chapter index the currently displayed result corresponds to (null = latest)
  const [viewingSnapshotIndex, setViewingSnapshotIndex] = useState<number | null>(null);
  const [spoilerDismissedIndex, setSpoilerDismissedIndex] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [uploadTab, setUploadTab] = useState<'file' | 'calibre' | 'mybooks' | 'library'>('file');
  const [importError, setImportError] = useState<string | null>(null);
  const [myBooksRev, setMyBooksRev] = useState(0);
  const [parentArcsRev, setParentArcsRev] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorkshop, setShowWorkshop] = useState(false);
  const [submitBook, setSubmitBook] = useState<{ title: string; author: string } | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [shareLabel, setShareLabel] = useState<'Share' | 'Copied!' | 'Shared!'>('Share');

  async function handleShare() {
    if (!book || !result || !stored || stored.lastAnalyzedIndex < 0) return;
    const chapterTitles = book.chapters.map((c) => c.title);
    const currentChapterTitle = chapterTitles[stored.lastAnalyzedIndex] ?? `Chapter ${stored.lastAnalyzedIndex + 1}`;
    const markdown = buildShareMarkdown(
      book.title, book.author, stored.lastAnalyzedIndex, currentChapterTitle,
      book.chapters.length, result, stored.snapshots, chapterTitles,
    );
    try {
      const outcome = await shareReadingContext(markdown, book.title);
      setShareLabel(outcome === 'shared' ? 'Shared!' : 'Copied!');
      setTimeout(() => setShareLabel('Share'), 2500);
    } catch {
      // AbortError — user cancelled share sheet; do nothing
    }
  }

  async function handleImport(file: File) {
    setImportError(null);
    try {
      const { title, author } = await importBookBuddy(file);
      loadBookFromMeta(title, author);
      setBookmarkModalMode('import');
      setShowBookmarkModal(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    }
  }

  const [rebuilding, setRebuilding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [rebuildProgress, setRebuildProgress] = useState<{ current: number; total: number; chapterTitle?: string; chapterIndex?: number } | null>(null);
  const rebuildCancelRef = useRef(false);
  const analyzeCancelRef = useRef(false);

  const [queue, setQueue] = useState<QueueJob[]>([]);
  const queueCancelRef = useRef(false);
  const queueRunningRef = useRef(false);
  // Stable ref to the active book so the queue processor doesn't capture a stale closure
  const bookRef = useRef<ParsedEbook | null>(null);

  const [chapterRange, setChapterRangeState] = useState<{ start: number; end: number } | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [mapState, setMapState] = useState<MapState | null>(null);
  const [showSetupPrompt, setShowSetupPrompt] = useState(false);

  // Fire-and-forget save wrappers — surface errors instead of swallowing them
  function persistState(title: string, author: string, state: StoredBookState) {
    saveBookState(title, author, state).catch((err) => {
      console.error('[book-storage] Save failed:', err);
      setSaveError('Failed to save analysis data. Your browser storage may be full.');
    });
  }
  function persistMapState(title: string, author: string, state: MapState) {
    saveBookMapState(title, author, state).catch((err) => {
      console.error('[book-storage] Map save failed:', err);
    });
  }

  // Export: use in-memory state for active book, fall back to IndexedDB
  async function exportBook(title: string, author: string, liveParsed?: ParsedEbook) {
    const isActiveBook = book && book.title === title && book.author === author;
    let state = isActiveBook ? storedRef.current : await loadBookState(title, author);
    if (!state) return;
    // Synthesize bookMeta from live parsed book if it wasn't saved yet
    if (!state.bookMeta && liveParsed && liveParsed.title === title && liveParsed.author === author) {
      state = { ...state, bookMeta: {
        chapters: liveParsed.chapters.map(({ id, title: t, order, bookIndex, bookTitle }) => ({ id, title: t, order, bookIndex, bookTitle })),
        books: liveParsed.books,
      }};
    }
    const ms = isActiveBook ? mapState : await loadBookMapState(title, author);
    const payload: BookBuddyExport = { version: 2, title, author, state, mapState: ms };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title} — ${author}.bookbuddy`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function setChapterRange(range: { start: number; end: number } | null) {
    setChapterRangeState(range);
    if (book && storedRef.current) {
      const updated: StoredBookState = { ...storedRef.current };
      if (range) updated.chapterRange = range; else delete updated.chapterRange;
      storedRef.current = updated;
      persistState(book.title, book.author, updated);
    }
  }

  function handleSetBookmark(index: number | null) {
    if (!book || !storedRef.current) return;
    const stored = storedRef.current;
    const updated: StoredBookState = { ...stored, readingBookmark: index ?? undefined };
    // Clean up: if readingBookmark is undefined, delete the key entirely
    if (index == null) delete (updated as any).readingBookmark;
    storedRef.current = updated;
    persistState(book.title, book.author, updated);

    // Navigate to the bookmarked chapter
    const bookmark = index ?? stored.lastAnalyzedIndex;
    setCurrentIndex(bookmark);
    setSpoilerDismissedIndex(null);
    if (bookmark >= stored.lastAnalyzedIndex) {
      setResult(stored.result);
      setViewingSnapshotIndex(null);
    } else {
      const snap = bestSnapshot(stored.snapshots, bookmark);
      if (snap) {
        setResult(snap.result);
        setViewingSnapshotIndex(snap.index);
      }
    }
  }

  function handleSetReadingPosition(position: ReadingPosition) {
    if (!book || !storedRef.current) return;
    const stored = storedRef.current;
    const updated: StoredBookState = { ...stored, readingPosition: position, readingBookmark: position.chapterIndex };
    persistState(book.title, book.author, updated);
    storedRef.current = updated;
    setCurrentIndex(position.chapterIndex);
    const snap = bestSnapshot(updated.snapshots, position.chapterIndex);
    if (snap) setResult(snap.result);
  }

  function handleUpdateParentArcs(parentArcs: ParentArc[]) {
    if (!book || !storedRef.current) return;
    const stored = storedRef.current;

    if (stored.series && bookFilter.mode === 'books' && bookFilter.indices.length === 1) {
      // Save to the specific book's parentArcs
      const bookIndex = bookFilter.indices[0];
      const updatedBooks = stored.series.books.map((b) =>
        b.index === bookIndex ? { ...b, parentArcs: parentArcs.length > 0 ? parentArcs : undefined } : b,
      );
      const updated = { ...stored, series: { ...stored.series, books: updatedBooks } };
      storedRef.current = updated;
      persistState(book.title, book.author, updated);
    } else if (stored.series && bookFilter.mode === 'all') {
      // Save to series-level arcs
      const updated = { ...stored, series: { ...stored.series, seriesArcs: parentArcs.length > 0 ? parentArcs : undefined } };
      storedRef.current = updated;
      persistState(book.title, book.author, updated);
    } else {
      // Non-series fallback
      const updated = { ...stored, parentArcs: parentArcs.length > 0 ? parentArcs : undefined };
      storedRef.current = updated;
      persistState(book.title, book.author, updated);
    }
    setParentArcsRev((r) => r + 1);
  }

  function handleSaveSeries(updatedSeries: SeriesDefinition) {
    if (!book || !storedRef.current) return;
    const updated = { ...storedRef.current, series: updatedSeries };
    storedRef.current = updated;
    persistState(book.title, book.author, updated);
    setShowBookStructureEditor(false);
  }

  async function handleReextractTitles(
    chapterOrders: number[],
  ): Promise<Map<number, { title: string; preview?: string }>> {
    if (!book) return new Map();

    const { loadChapters } = await import('@/lib/chapter-storage');
    const { extractExtendedHeading, extractText, extractPreview } = await import('@/lib/epub-parser');

    const entries = await loadChapters(book.title, book.author);
    if (!entries) return new Map();

    const orderToId = new Map<number, string>();
    if (storedRef.current?.bookMeta) {
      for (const ch of storedRef.current.bookMeta.chapters) {
        orderToId.set(ch.order, ch.id);
      }
    }

    const result = new Map<number, { title: string; preview?: string }>();
    for (const order of chapterOrders) {
      const id = orderToId.get(order);
      if (!id) continue;
      const entry = entries.find((e) => e.id === id);
      if (!entry) continue;

      let newTitle: string | undefined;

      // Try re-extraction from stored HTML head
      if (entry.htmlHead) {
        const headingMatch = entry.htmlHead.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
        const rawTitle = headingMatch?.[1] ? extractText(headingMatch[1]) : '';
        if (rawTitle.trim()) {
          newTitle = rawTitle.trim();
        } else {
          const extended = extractExtendedHeading(entry.htmlHead);
          if (extended) newTitle = extended;
        }
      }

      // Fallback: use first line of plain text only if it looks title-like (short, no sentence punctuation)
      if (!newTitle) {
        const firstLine = entry.text.split('\n').find((l) => l.trim().length > 0)?.trim();
        if (firstLine && firstLine.length < 60 && !/[.!?,;]/.test(firstLine)) {
          newTitle = firstLine;
        }
      }

      if (newTitle) {
        const preview = extractPreview(entry.text);
        result.set(order, { title: newTitle, preview: preview || undefined });
      }
    }

    // Update bookMeta with new titles
    if (result.size > 0 && storedRef.current?.bookMeta) {
      const updatedChapters = storedRef.current.bookMeta.chapters.map((ch) => {
        const update = result.get(ch.order);
        if (!update) return ch;
        return { ...ch, title: update.title, preview: update.preview ?? ch.preview };
      });
      const updatedMeta = { ...storedRef.current.bookMeta, chapters: updatedChapters };
      storedRef.current = { ...storedRef.current, bookMeta: updatedMeta };
      persistState(book.title, book.author, storedRef.current);
    }

    return result;
  }

  function completeSetup(range: { start: number; end: number }) {
    setChapterRange(range);
    setNeedsSetup(false);
    setCurrentIndex(range.start);
  }

  const [tab, setTab] = useState<MainTab>('characters');
  const [sortKey, setSortKey] = useState<SortKey>('importance');
  const [filter, setFilter] = useState<Character['importance'] | 'all'>('all');
  const [search, setSearch] = useState('');

  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(2000); // ms per step
  const [showBookmarkModal, setShowBookmarkModal] = useState(false);
  const [bookmarkModalMode, setBookmarkModalMode] = useState<'import' | 'update'>('update');
  const [showBookStructureEditor, setShowBookStructureEditor] = useState(false);
  const [bookStructureMode, setBookStructureMode] = useState<'setup' | 'manage'>('setup');
  const [bookFilter, setBookFilter] = useState<BookFilter>({ mode: 'all' });
  const [showSearch, setShowSearch] = useState(false);
  const [searchEntity, setSearchEntity] = useState<{ type: 'character' | 'location' | 'arc'; name: string } | null>(null);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive playback: advance one snapshot per interval tick
  useEffect(() => {
    if (playIntervalRef.current) { clearInterval(playIntervalRef.current); playIntervalRef.current = null; }
    if (!playing) return;
    playIntervalRef.current = setInterval(() => {
      const stored = storedRef.current;
      if (!stored?.snapshots?.length) { setPlaying(false); return; }
      const snaps = [...stored.snapshots].sort((a, b) => a.index - b.index);
      setViewingSnapshotIndex((cur) => {
        const pos = cur === null ? snaps.length - 1 : snaps.findIndex((s) => s.index === cur);
        const next = pos + 1;
        if (next >= snaps.length) {
          // Reached the end — stop
          setPlaying(false);
          return null;
        }
        const target = snaps[next];
        setCurrentIndex(target.index);
        setResult(target.result);
        return target.index;
      });
    }, playSpeed);
    return () => { if (playIntervalRef.current) clearInterval(playIntervalRef.current); };
  }, [playing, playSpeed]);

  // Sync state across browser tabs via BroadcastChannel
  useEffect(() => {
    return onCrossTabSync(async (msg) => {
      if (!book || msg.title !== book.title || msg.author !== book.author) return;
      if (msg.type === 'map') {
        const ms = await loadBookMapState(msg.title, msg.author);
        setMapState(ms);
      } else if (msg.type === 'state') {
        const updated = await loadBookState(msg.title, msg.author);
        if (!updated) return;
        storedRef.current = updated;
        if (!playing) {
          setResult(updated.result);
          setCurrentIndex(updated.lastAnalyzedIndex);
          setViewingSnapshotIndex(null);
        }
      }
    });
  }, [book, playing]);

  const storedRef = useRef<StoredBookState | null>(null);
  const seriesBaseRef = useRef<AnalysisResult | null>(null);
  const mapStateRef = useRef<MapState | null>(null);
  useEffect(() => { mapStateRef.current = mapState; }, [mapState]);

  const visibleChapterOrders = useMemo(() => {
    const series = storedRef.current?.series;
    if (!series) return null;
    const targetBooks = bookFilter.mode === 'all'
      ? series.books
      : series.books.filter((b) => bookFilter.indices.includes(b.index));
    const visible = new Set<number>();
    for (const b of targetBooks) {
      if (b.excluded) continue;
      for (let o = b.chapterStart; o <= b.chapterEnd; o++) {
        if (!b.excludedChapters.includes(o)) visible.add(o);
      }
    }
    return visible;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedRef.current?.series, bookFilter]);

  const visibleSnapshots = useMemo(() => {
    const snaps = storedRef.current?.snapshots ?? [];
    if (!visibleChapterOrders) return snaps;
    return snaps.filter((s) => visibleChapterOrders.has(s.index));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedRef.current?.snapshots, visibleChapterOrders]);

  // Auto-navigate when current chapter falls outside visible set
  useEffect(() => {
    if (!visibleChapterOrders || visibleChapterOrders.size === 0 || visibleChapterOrders.has(currentIndex)) return;
    const stored = storedRef.current;
    if (stored?.snapshots?.length) {
      const visibleSnaps = stored.snapshots
        .filter((s) => visibleChapterOrders.has(s.index))
        .sort((a, b) => b.index - a.index);
      if (visibleSnaps.length > 0) {
        const target = visibleSnaps[0];
        setCurrentIndex(target.index);
        setResult(target.result);
        setViewingSnapshotIndex(target.index);
        return;
      }
    }
    setCurrentIndex(Math.min(...visibleChapterOrders));
  }, [visibleChapterOrders, currentIndex]);

  const handleSearchEntitySelect = useCallback((type: 'character' | 'location' | 'arc', name: string) => {
    setShowSearch(false);
    setSearchEntity({ type, name });
  }, []);

  const applyResultEdit = useCallback((
    updatedResult: AnalysisResult,
    propagate?: SnapshotTransform,
    pinUpdates?: PinUpdates,
  ) => {
    if (!book) return;
    // When propagating, shallow-copy to guarantee a new reference so React re-renders
    // even if the transform was a no-op on the current result (e.g. historical-only entity)
    const newResult = propagate ? { ...updatedResult } : updatedResult;
    setResult(newResult);
    const cur = storedRef.current;
    if (cur) {
      const snapshots = propagate
        ? cur.snapshots.map((snap) => ({ ...snap, result: propagate(snap.result) }))
        : cur.snapshots;
      let updated: StoredBookState = { ...cur, result: newResult, snapshots };

      // Sync parentArcs with arc edits (rename, delete, merge, split)
      if (updated.parentArcs?.length) {
        const oldArcNames = new Set((cur.result.arcs ?? []).map((a) => a.name));
        const newArcNames = new Set((newResult.arcs ?? []).map((a) => a.name));
        const removed = [...oldArcNames].filter((n) => !newArcNames.has(n));
        const added = [...newArcNames].filter((n) => !oldArcNames.has(n));

        let parentArcs: ParentArc[];

        if (removed.length === 1 && added.length === 1) {
          // Rename: replace old child name with new name in-place
          parentArcs = updated.parentArcs.map((pa) => ({
            ...pa,
            children: pa.children.map((c) => c === removed[0] ? added[0] : c),
          }));
        } else {
          // Delete/merge: remove old names from children
          parentArcs = updated.parentArcs.map((pa) => ({
            ...pa,
            children: pa.children.filter((c) => !removed.includes(c)),
          }));
          // Split: original stays, new arc added to same parent
          if (added.length > 0 && removed.length === 0) {
            const newArcs = (newResult.arcs ?? []).filter((a) => added.includes(a.name));
            for (const na of newArcs) {
              const placed = parentArcs.find((pa) =>
                pa.children.some((c) => {
                  const existing = (newResult.arcs ?? []).find((a) => a.name === c);
                  return existing?.characters.some((ch) => na.characters.includes(ch));
                })
              );
              if (placed) placed.children.push(na.name);
              else parentArcs[parentArcs.length - 1]?.children.push(na.name);
            }
          }
        }
        // Remove empty parents
        parentArcs = parentArcs.filter((pa) => pa.children.length > 0);
        updated = { ...updated, parentArcs: parentArcs.length > 0 ? parentArcs : undefined };
      }

      // Also sync per-book parentArcs in series
      if (updated.series) {
        const oldArcNamesS = new Set((cur.result.arcs ?? []).map((a) => a.name));
        const newArcNamesS = new Set((newResult.arcs ?? []).map((a) => a.name));
        const removedS = [...oldArcNamesS].filter((n) => !newArcNamesS.has(n));
        const addedS = [...newArcNamesS].filter((n) => !oldArcNamesS.has(n));

        const syncedBooks = updated.series.books.map((b) => {
          if (!b.parentArcs?.length) return b;
          let bookParentArcs: ParentArc[];
          if (removedS.length === 1 && addedS.length === 1) {
            bookParentArcs = b.parentArcs.map((pa) => ({
              ...pa,
              children: pa.children.map((c) => c === removedS[0] ? addedS[0] : c),
            }));
          } else {
            bookParentArcs = b.parentArcs.map((pa) => ({
              ...pa,
              children: pa.children.filter((c) => !removedS.includes(c)),
            }));
            if (addedS.length > 0 && removedS.length === 0) {
              const newArcs = (newResult.arcs ?? []).filter((a) => addedS.includes(a.name));
              for (const na of newArcs) {
                const placed = bookParentArcs.find((pa) =>
                  pa.children.some((c) => {
                    const existing = (newResult.arcs ?? []).find((a) => a.name === c);
                    return existing?.characters.some((ch) => na.characters.includes(ch));
                  })
                );
                if (placed) placed.children.push(na.name);
                else bookParentArcs[bookParentArcs.length - 1]?.children.push(na.name);
              }
            }
          }
          bookParentArcs = bookParentArcs.filter((pa) => pa.children.length > 0);
          return { ...b, parentArcs: bookParentArcs.length > 0 ? bookParentArcs : undefined };
        });
        updated = { ...updated, series: { ...updated.series, books: syncedBooks } };
      }

      storedRef.current = updated;
      persistState(book.title, book.author, updated);
    }

    if (pinUpdates) {
      const ms = mapStateRef.current;
      if (ms) {
        const pins = { ...ms.pins };
        if (pinUpdates.renames) {
          for (const [oldName, newName] of Object.entries(pinUpdates.renames)) {
            if (oldName in pins) {
              if (!(newName in pins)) pins[newName] = pins[oldName];
              delete pins[oldName];
            }
          }
        }
        if (pinUpdates.deletes) {
          for (const name of pinUpdates.deletes) delete pins[name];
        }
        const next = { ...ms, pins };
        setMapState(next);
        persistMapState(book.title, book.author, next);
      }
    }
  }, [book]);

  // Keep bookRef in sync so the queue processor can read the active book without stale closures
  useEffect(() => { bookRef.current = book; }, [book]);

  // Queue processor: runs one job at a time, saving results to localStorage
  useEffect(() => {
    if (queueRunningRef.current) return;
    const job = queue.find((j) => j.status === 'waiting');
    if (!job) return;

    queueRunningRef.current = true;
    queueCancelRef.current = false;
    const { id, title, author } = job;
    setQueue((q) => q.map((j) => j.id === id ? { ...j, status: 'running' as const } : j));

    async function run() {
      try {
        const stored = await loadBookState(title, author);
        if (!stored?.bookMeta) throw new Error('No book metadata — open the book first');

        const entries = await loadChapters(title, author);
        if (!entries?.length) throw new Error('EPUB text not available — re-upload the file');
        const textMap = new Map(entries.map(({ id: cid, text }) => [cid, text]));

        const chapters = stored.bookMeta.chapters.map((ch) => ({ ...ch, text: textMap.get(ch.id) ?? '' }));
        const startIndex = stored.lastAnalyzedIndex >= 0 ? stored.lastAnalyzedIndex + 1 : 0;
        const toIndex = chapters.length - 1;
        const total = toIndex - startIndex + 1;

        if (total <= 0) {
          setQueue((q) => q.map((j) => j.id === id ? { ...j, status: 'done' as const } : j));
          return;
        }

        let accumulated: AnalysisResult | null = stored.lastAnalyzedIndex >= 0 ? stored.result : null;
        let snapshots = [...(stored.snapshots ?? [])];
        const seriesExcluded = new Set<number>();
        if (stored.series) {
          for (const b of stored.series.books) {
            if (b.excluded) {
              for (let o = b.chapterStart; o <= b.chapterEnd; o++) seriesExcluded.add(o);
            } else {
              for (const ex of b.excludedChapters) seriesExcluded.add(ex);
            }
          }
          for (const uo of stored.series.unassignedChapters) seriesExcluded.add(uo);
        }
        let latestStored: StoredBookState = { ...stored };
        let recentText = '';
        const MAX_RECENT_TEXT = 30_000;

        for (let i = startIndex; i <= toIndex; i++) {
          if (queueCancelRef.current) {
            setQueue((q) => q.map((j) => j.id === id ? { ...j, status: 'waiting' as const, progress: undefined } : j));
            return;
          }
          setQueue((q) => q.map((j) => j.id === id
            ? { ...j, progress: { current: i - startIndex + 1, total, chapterTitle: chapters[i]?.title } }
            : j));

          const ch = chapters[i];
          if (stored.series) {
            if (seriesExcluded.has(i)) {
              if (accumulated) {
                snapshots = upsertSnapshot(snapshots, i, accumulated);
                latestStored = { ...latestStored, lastAnalyzedIndex: i, result: accumulated, snapshots };
                persistState(title, author, latestStored);
                if (bookRef.current?.title === title && bookRef.current?.author === author) {
                  storedRef.current = latestStored;
                }
              }
              continue;
            }
          } else {
            if (isFrontMatter(ch)) {
              if (accumulated) {
                snapshots = upsertSnapshot(snapshots, i, accumulated);
                latestStored = { ...latestStored, lastAnalyzedIndex: i, result: accumulated, snapshots };
                persistState(title, author, latestStored);
                if (bookRef.current?.title === title && bookRef.current?.author === author) {
                  storedRef.current = latestStored;
                }
              }
              continue;
            }
          }

          const { result: chResult, model: chModel, events: chEvents } = await analyzeChapter(title, author, { title: ch.title, text: ch.text }, accumulated, chapters.map((c) => c.title));
          accumulated = chResult;
          recentText += `\n=== ${ch.title} ===\n${ch.text}`;
          if (recentText.length > MAX_RECENT_TEXT) recentText = recentText.slice(-MAX_RECENT_TEXT);
          snapshots = upsertSnapshot(snapshots, i, accumulated, chModel, APP_VERSION, chEvents);
          latestStored = { ...latestStored, lastAnalyzedIndex: i, result: accumulated, snapshots };
          persistState(title, author, latestStored);

          // If this is the active book, update the live view too
          if (bookRef.current?.title === title && bookRef.current?.author === author) {
            storedRef.current = latestStored;
            setResult(accumulated);
            setViewingSnapshotIndex(null);
          }

          // Periodic reconciliation every 10 chapters
          const chaptersProcessed = i - startIndex + 1;
          if (accumulated && chaptersProcessed > 0 && chaptersProcessed % 10 === 0) {
            setQueue((q) => q.map((j) => j.id === id
              ? { ...j, progress: { current: chaptersProcessed, total, chapterTitle: 'Reconciling…' } }
              : j));
            try {
              accumulated = await reconcileResult(title, author, accumulated, recentText);
              snapshots = upsertSnapshot(snapshots, i, accumulated, undefined, APP_VERSION);
              latestStored = { ...latestStored, result: accumulated, snapshots };
              persistState(title, author, latestStored);
              if (bookRef.current?.title === title && bookRef.current?.author === author) {
                storedRef.current = latestStored;
                setResult(accumulated);
              }
            } catch (reconcileErr) {
              console.warn('[queue] Periodic reconciliation failed, continuing:', reconcileErr);
            }
          }
        }

        // Final reconciliation after all chapters processed
        if (accumulated) {
          setQueue((q) => q.map((j) => j.id === id
            ? { ...j, progress: { current: total, total, chapterTitle: 'Reconciling…' } }
            : j));
          try {
            accumulated = await reconcileResult(title, author, accumulated, recentText);
            snapshots = upsertSnapshot(snapshots, toIndex, accumulated, undefined, APP_VERSION);
            latestStored = { ...latestStored, result: accumulated, snapshots };
            persistState(title, author, latestStored);
            if (bookRef.current?.title === title && bookRef.current?.author === author) {
              storedRef.current = latestStored;
              setResult(accumulated);
            }
          } catch (reconcileErr) {
            console.warn('[queue] Final reconciliation failed, keeping unreconciled result:', reconcileErr);
          }
        }

        // Generate parent arcs after full book processing
        if (accumulated?.arcs?.length) {
          try {
            const parentArcs = await generateParentArcs(title, author, accumulated.arcs);
            latestStored = { ...latestStored, parentArcs };
            persistState(title, author, latestStored);
            if (bookRef.current?.title === title && bookRef.current?.author === author) {
              storedRef.current = latestStored;
            }
          } catch (e) { console.warn('[parent-arcs] Queue generation failed:', e); }
        }

        setQueue((q) => q.map((j) => j.id === id ? { ...j, status: 'done' as const, progress: undefined } : j));
      } catch (err) {
        setQueue((q) => q.map((j) => j.id === id
          ? { ...j, status: 'error' as const, error: err instanceof Error ? err.message : 'Failed', progress: undefined }
          : j));
      } finally {
        queueRunningRef.current = false;
      }
    }

    run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  function activateBook(parsed: ParsedEbook, initialStored: StoredBookState | null, initialMapState?: MapState | null) {
    const bookMeta: BookMeta = {
      chapters: parsed.chapters.map(({ id, title, order, bookIndex, bookTitle, preview, contentType }) =>
        ({ id, title, order, bookIndex, bookTitle, preview, contentType })),
      books: parsed.books,
    };
    let stateToSave: StoredBookState = initialStored
      ? { ...initialStored, bookMeta }
      : { lastAnalyzedIndex: -2, result: { characters: [], summary: '' }, snapshots: [], bookMeta };

    // Build or migrate series definition
    if (!stateToSave.series && bookMeta.books && bookMeta.books.length >= 2) {
      if (initialStored?.excludedBooks || initialStored?.bookMeta) {
        // Migrate from legacy fields
        const series = migrateToSeriesDefinition(bookMeta, initialStored?.excludedBooks);
        if (series) stateToSave = { ...stateToSave, series };
      } else {
        // Fresh book — build from parser output
        const chapterTexts = new Map<number, { title: string; text: string }>();
        for (const ch of parsed.chapters) {
          chapterTexts.set(ch.order, { title: ch.title, text: ch.text });
        }
        const series = buildInitialSeriesDefinition(bookMeta, detectChapterRange, chapterTexts);
        if (series) stateToSave = { ...stateToSave, series };
      }
    }

    storedRef.current = stateToSave;
    persistState(parsed.title, parsed.author, stateToSave);
    // Persist chapter texts in IndexedDB so re-upload is not required next session
    const chaptersWithText = parsed.chapters.filter((ch) => ch.text).map((ch) => ({
      id: ch.id,
      text: ch.text,
      htmlHead: (ch as unknown as Record<string, string>)._htmlHead,
    }));
    if (chaptersWithText.length > 0) {
      saveChapters(parsed.title, parsed.author, chaptersWithText).catch(() => {});
    }
    seriesBaseRef.current = initialStored?.lastAnalyzedIndex === -1 ? initialStored.result : null;
    setChapterRangeState(initialStored?.chapterRange ?? null);
    setMapState(initialMapState ?? null);
    setBook(parsed);
    setBookFilter({ mode: 'all' });
    if (initialStored && initialStored.lastAnalyzedIndex >= 0) {
      const bookmark = initialStored.readingBookmark;
      if (bookmark != null && bookmark < initialStored.lastAnalyzedIndex) {
        // Load the bookmark's snapshot as the default view
        const snap = bestSnapshot(initialStored.snapshots, bookmark);
        setResult(snap?.result ?? initialStored.result);
        setViewingSnapshotIndex(snap?.index ?? null);
        setSpoilerDismissedIndex(null);
        setCurrentIndex(bookmark);
      } else {
        setResult(initialStored.result);
        setViewingSnapshotIndex(null);
        setSpoilerDismissedIndex(null);
        const nextIdx = Math.min(initialStored.lastAnalyzedIndex + 1, parsed.chapters.length - 1);
        setCurrentIndex(nextIdx);
      }
    } else {
      setViewingSnapshotIndex(null);
      setSpoilerDismissedIndex(null);
      setCurrentIndex(0);
    }

    const isNewBook = !initialStored || initialStored.lastAnalyzedIndex === -2;
    const hasNoRange = !initialStored?.chapterRange;
    const hasText = parsed.chapters.some((ch) => ch.text);

    if (isNewBook && hasNoRange && hasText) {
      const detected = detectChapterRange(parsed.chapters);
      setChapterRangeState(detected);
      setNeedsSetup(true);
    } else {
      setNeedsSetup(false);
    }

    // Show book structure editor for multi-book EPUBs with unconfirmed structure
    if (stateToSave.series && stateToSave.series.books.some((b) => !b.confirmed)) {
      setBookStructureMode('setup');
      setShowBookStructureEditor(true);
    }
  }

  async function loadBookFromMeta(title: string, author: string) {
    let stored = await loadBookState(title, author);
    if (!stored) return;

    // Migrate legacy state to series definition if needed
    if (!stored.series && stored.bookMeta?.books && stored.bookMeta.books.length >= 2) {
      const series = migrateToSeriesDefinition(stored.bookMeta, stored.excludedBooks);
      if (series) {
        stored = { ...stored, series };
        // Persist migrated state
        persistState(title, author, stored);
      }
    }

    // Try to restore chapter texts from IndexedDB
    let textMap: Map<string, string> | null = null;
    try {
      const entries = await loadChapters(title, author);
      if (entries && entries.length > 0) {
        textMap = new Map(entries.map(({ id, text }) => [id, text]));
      }
    } catch { /* IndexedDB unavailable — proceed without text */ }
    const parsed: ParsedEbook = stored.bookMeta
      ? {
          title,
          author,
          chapters: stored.bookMeta.chapters.map((ch) => ({ ...ch, text: textMap?.get(ch.id) ?? '' })),
          books: stored.bookMeta.books,
        }
      : {
          title,
          author,
          // No chapter list available — analysis data still loads fine
          chapters: [],
        };
    const ms = await loadBookMapState(title, author);
    activateBook(parsed, stored, ms);
  }

  /** Called whenever the user selects a chapter in the sidebar */
  function handleChapterChange(i: number) {
    setCurrentIndex(i);
    const stored = storedRef.current;
    if (!stored || stored.lastAnalyzedIndex < 0) return;

    const bookmark = Math.min(
      stored.readingBookmark ?? stored.lastAnalyzedIndex,
      stored.lastAnalyzedIndex,
    );

    if (i > bookmark) {
      // Beyond bookmark — don't load snapshot yet, show spoiler warning
      setSpoilerDismissedIndex(null);
      return;
    }

    // Within bookmark — clear spoiler state and load snapshot
    setSpoilerDismissedIndex(null);

    if (i >= stored.lastAnalyzedIndex) {
      setResult(stored.result);
      setViewingSnapshotIndex(null);
    } else {
      const snap = bestSnapshot(stored.snapshots, i);
      if (snap) {
        setResult(snap.result);
        setViewingSnapshotIndex(snap.index);
      }
    }
  }

  function handleDismissSpoiler() {
    const stored = storedRef.current;
    if (!stored) return;
    setSpoilerDismissedIndex(currentIndex);
    if (currentIndex >= stored.lastAnalyzedIndex) {
      setResult(stored.result);
      setViewingSnapshotIndex(null);
    } else {
      const snap = bestSnapshot(stored.snapshots, currentIndex);
      if (snap) {
        setResult(snap.result);
        setViewingSnapshotIndex(snap.index);
      }
    }
  }

  const handleFile = useCallback(async (file: File) => {
    // .bookbuddy / legacy .etbook import shortcut
    if (file.name.endsWith('.bookbuddy') || file.name.endsWith('.etbook')) {
      await handleImport(file);
      return;
    }
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
      const ownStored = await loadBookState(parsed.title, parsed.author);
      if (ownStored) {
        const ownMap = await loadBookMapState(parsed.title, parsed.author);
        activateBook(parsed, ownStored, ownMap);
        return;
      }
      const others = listSavedBooks(parsed.title, parsed.author).filter((b) => b.lastAnalyzedIndex >= 0);
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

  async function handleContinueFrom(prevTitle: string, prevAuthor: string) {
    if (!pendingBook) return;
    const prevStored = await loadBookState(prevTitle, prevAuthor);
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

  function analyzableIndices(from: number, to: number): number[] {
    if (!book) return [];
    const result: number[] = [];
    for (let i = from; i <= to; i++) {
      const ch = book.chapters[i];
      if (!ch) continue;
      if (visibleChapterOrders && !visibleChapterOrders.has(i)) continue;
      if (!visibleChapterOrders && isFrontMatter(ch)) continue;
      result.push(i);
    }
    return result;
  }

  const handleAnalyze = useCallback(async () => {
    if (!book || needsSetup) return;

    // Pre-flight: check if provider is configured
    const { loadAiSettings } = await import('@/lib/ai-client');
    const settings = loadAiSettings();
    const hasCredentials =
      (settings.provider === 'anthropic' && settings.anthropicKey) ||
      (settings.provider === 'ollama' && settings.ollamaUrl) ||
      (settings.provider === 'gemini' && settings.geminiKey) ||
      (settings.provider === 'openai-compatible' && settings.openaiCompatibleUrl);
    if (!hasCredentials) {
      setShowSetupPrompt(true);
      return;
    }

    analyzeCancelRef.current = false;
    setAnalyzing(true);
    setAnalyzeError(null);

    const stored = storedRef.current;
    const rangeStart = chapterRange?.start ?? 0;
    const rangeEnd = chapterRange?.end ?? (book.chapters.length - 1);
    const lastAnalyzed = stored && stored.lastAnalyzedIndex >= 0 ? stored.lastAnalyzedIndex : -1;
    const startIndex = Math.max(lastAnalyzed + 1, rangeStart);
    const endIndex = Math.min(currentIndex, rangeEnd);
    const toAnalyze = analyzableIndices(startIndex, endIndex);
    const total = toAnalyze.length;
    if (total === 0) { setAnalyzing(false); setRebuildProgress(null); return; }
    setRebuildProgress({ current: 0, total });

    let accumulated: AnalysisResult | null =
      stored && stored.lastAnalyzedIndex >= 0 ? stored.result : seriesBaseRef.current;
    let snapshots: Snapshot[] = stored?.snapshots ?? [];
    const analyzeBase = stored ?? { lastAnalyzedIndex: -1, result: { characters: [], summary: '' }, snapshots: [] };

    try {
      for (let step = 0; step < toAnalyze.length; step++) {
        if (analyzeCancelRef.current) break;
        const i = toAnalyze[step];
        const ch = book.chapters[i];
        setRebuildProgress({ current: step + 1, total, chapterTitle: ch.title, chapterIndex: i });
        const { result: chapterResult, model: chapterModel, rateLimitWaitMs, events: chapterEvents } = await analyzeChapter(book.title, book.author, { title: ch.title, text: ch.text }, accumulated, book.chapters.map((c) => c.title));
        if (rateLimitWaitMs) {
          setRebuildProgress((prev) => prev ? { ...prev, chapterTitle: `${ch.title} (rate limit: waited ${Math.ceil(rateLimitWaitMs / 1000)}s)` } : prev);
        }
        accumulated = chapterResult;
        snapshots = upsertSnapshot(snapshots, i, accumulated, chapterModel, APP_VERSION, chapterEvents);
        const partial: StoredBookState = { ...analyzeBase, lastAnalyzedIndex: i, result: accumulated, snapshots };
        storedRef.current = partial;
        persistState(book.title, book.author, partial);
        setResult(accumulated);
        setViewingSnapshotIndex(null);
      }

      // Generate parent arcs if all chapters in range are now analyzed
      const rEnd = chapterRange?.end ?? (book.chapters.length - 1);
      const withParents = await maybeGenerateParentArcs(storedRef.current!, book.title, book.author, rEnd, analyzeCancelRef.current);
      storedRef.current = withParents;
      persistState(book.title, book.author, withParents);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      setAnalyzing(false);
      setRebuildProgress(null);
      analyzeCancelRef.current = false;
    }
  }, [book, currentIndex, visibleChapterOrders, chapterRange, needsSetup]);

  const handleRebuild = useCallback(async () => {
    if (!book) return;
    rebuildCancelRef.current = false;
    setRebuilding(true);
    setAnalyzeError(null);
    const rebuildRangeStart = chapterRange?.start ?? 0;
    const rebuildRangeEnd = Math.min(currentIndex, chapterRange?.end ?? currentIndex);
    const toRebuild = analyzableIndices(rebuildRangeStart, rebuildRangeEnd);
    const rebuildTotal = toRebuild.length;
    if (rebuildTotal === 0) { setRebuilding(false); setRebuildProgress(null); return; }
    setRebuildProgress({ current: 0, total: rebuildTotal });

    let accumulated: AnalysisResult | null = seriesBaseRef.current;
    let snapshots: Snapshot[] = storedRef.current?.snapshots ?? [];
    const rebuildBase = storedRef.current ?? { lastAnalyzedIndex: -1, result: { characters: [], summary: '' }, snapshots: [] };

    try {
      for (let step = 0; step < toRebuild.length; step++) {
        if (rebuildCancelRef.current) break;
        const i = toRebuild[step];
        const ch = book.chapters[i];
        setRebuildProgress({ current: step + 1, total: rebuildTotal, chapterTitle: ch.title, chapterIndex: i });
        const { result: rebuildResult, model: rebuildModel, events: rebuildEvents } = await analyzeChapter(book.title, book.author, { title: ch.title, text: ch.text }, accumulated, book.chapters.map((c) => c.title));
        accumulated = rebuildResult;
        snapshots = upsertSnapshot(snapshots, i, accumulated, rebuildModel, APP_VERSION, rebuildEvents);
        const partial: StoredBookState = { ...rebuildBase, lastAnalyzedIndex: i, result: accumulated, snapshots };
        storedRef.current = partial;
        persistState(book.title, book.author, partial);
        setResult(accumulated);
        setViewingSnapshotIndex(null);
      }

      const rEnd = chapterRange?.end ?? (book.chapters.length - 1);
      const withParents = await maybeGenerateParentArcs(storedRef.current!, book.title, book.author, rEnd, rebuildCancelRef.current);
      storedRef.current = withParents;
      persistState(book.title, book.author, withParents);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Rebuild failed.');
    } finally {
      setRebuilding(false);
      setRebuildProgress(null);
      rebuildCancelRef.current = false;
    }
  }, [book, currentIndex, visibleChapterOrders, chapterRange]);

  // Process the full range start→end regardless of currentIndex
  const handleProcessBook = useCallback(async () => {
    if (!book) return;
    rebuildCancelRef.current = false;
    setRebuilding(true);
    setAnalyzeError(null);
    const rangeStart = chapterRange?.start ?? 0;
    const rangeEnd = chapterRange?.end ?? (book.chapters.length - 1);
    const toProcess = analyzableIndices(rangeStart, rangeEnd);
    const total = toProcess.length;
    if (total === 0) { setRebuilding(false); setRebuildProgress(null); return; }
    setRebuildProgress({ current: 0, total });

    let accumulated: AnalysisResult | null = seriesBaseRef.current;
    let snapshots: Snapshot[] = storedRef.current?.snapshots ?? [];
    const processBase = storedRef.current ?? { lastAnalyzedIndex: -1, result: { characters: [], summary: '' }, snapshots: [] };

    try {
      for (let step = 0; step < toProcess.length; step++) {
        if (rebuildCancelRef.current) break;
        const i = toProcess[step];
        const ch = book.chapters[i];
        setRebuildProgress({ current: step + 1, total, chapterTitle: ch.title, chapterIndex: i });
        const { result: chResult, model: chModel, events: chEvents } = await analyzeChapter(book.title, book.author, { title: ch.title, text: ch.text }, accumulated, book.chapters.map((c) => c.title));
        accumulated = chResult;
        snapshots = upsertSnapshot(snapshots, i, accumulated, chModel, APP_VERSION, chEvents);
        const partial: StoredBookState = { ...processBase, lastAnalyzedIndex: i, result: accumulated, snapshots };
        storedRef.current = partial;
        persistState(book.title, book.author, partial);
        setResult(accumulated);
        setCurrentIndex(i);
        setViewingSnapshotIndex(null);
      }

      const rEnd = chapterRange?.end ?? (book.chapters.length - 1);
      const withParents = await maybeGenerateParentArcs(storedRef.current!, book.title, book.author, rEnd, rebuildCancelRef.current);
      storedRef.current = withParents;
      persistState(book.title, book.author, withParents);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Process failed.');
    } finally {
      setRebuilding(false);
      setRebuildProgress(null);
      rebuildCancelRef.current = false;
    }
  }, [book, visibleChapterOrders, chapterRange]);

  const handleDeleteSnapshot = useCallback((index: number) => {
    if (!book || !storedRef.current) return;
    const cur = storedRef.current;
    // Remove snapshot at index and all later ones (they're based on the deleted analysis)
    const newSnapshots = cur.snapshots.filter((s) => s.index < index);
    if (newSnapshots.length === 0) {
      const updated: StoredBookState = { lastAnalyzedIndex: -2, result: { characters: [], summary: '' }, snapshots: [], bookMeta: cur.bookMeta };
      storedRef.current = updated;
      persistState(book.title, book.author, updated);
      setResult(null);
      setViewingSnapshotIndex(null);
      return;
    }
    const sortedSnaps = [...newSnapshots].sort((a, b) => b.index - a.index);
    const newLastIdx = sortedSnaps[0].index;
    const newResult = sortedSnaps[0].result;
    const updated: StoredBookState = { lastAnalyzedIndex: newLastIdx, result: newResult, snapshots: newSnapshots, bookMeta: cur.bookMeta };
    storedRef.current = updated;
    persistState(book.title, book.author, updated);
    setResult(newResult);
    setViewingSnapshotIndex(null);
    if (currentIndex > newLastIdx) setCurrentIndex(newLastIdx);
  }, [book, currentIndex]);

  const characters = result?.characters ?? [];
  const derived = useDerivedEntities(
    storedRef.current?.snapshots ?? [],
    result ?? null,
    visibleSnapshots.length !== (storedRef.current?.snapshots ?? []).length ? visibleSnapshots : undefined,
  );
  const displayed = characters
    .filter((c) => {
      if (filter !== 'all' && c.importance !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        const hit = c.name.toLowerCase().includes(q)
          || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q));
        if (!hit) return false;
      }
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
      <main className="min-h-dvh">
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
    void myBooksRev; void migrationDone; // trigger re-render after deletion or migration
    const savedBooks = listSavedBooks();
    return (
      <main className="min-h-dvh flex flex-col bg-paper">
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        {submitBook && <LibrarySubmitModal title={submitBook.title} author={submitBook.author} onClose={() => setSubmitBook(null)} />}
        <div className="flex items-end border-b border-border px-2 sm:px-6 pt-4 sm:pt-6 overflow-x-auto scrollbar-none">
          {([
            { key: 'file', label: 'Upload EPUB' },
            ...(!IS_MOBILE ? [{ key: 'calibre' as const, label: 'Calibre' }] : []),
            { key: 'mybooks', label: `My Books${savedBooks.length > 0 ? ` (${savedBooks.length})` : ''}` },
            { key: 'library', label: 'Library' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setUploadTab(key)}
              suppressHydrationWarning={key === 'mybooks'}
              className={`flex-shrink-0 px-2.5 sm:px-4 py-2 text-xs sm:text-sm font-medium rounded-t-lg border-b-2 transition-colors -mb-px whitespace-nowrap ${
                uploadTab === key
                  ? 'border-amber-500 text-amber-400'
                  : 'border-transparent text-ink-dim hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="flex-shrink-0 ml-auto pb-2 pl-2 flex items-center gap-2">
            <ProcessingQueue
              jobs={queue}
              onRemove={(id) => setQueue((q) => q.filter((j) => j.id !== id))}
              onCancelCurrent={() => { queueCancelRef.current = true; }}
              onClearDone={() => setQueue((q) => q.filter((j) => j.status !== 'done' && j.status !== 'error'))}
            />
            <button
              onClick={() => setShowSettings(true)}
              className="text-xs text-ink-dim hover:text-ink transition-colors"
              title="AI Settings"
            >
              ⚙ Settings
            </button>
          </div>
        </div>
        <div className="flex-1 p-4 sm:p-6">
          {uploadTab === 'file' ? (
            <>
              <WelcomeBanner />
              <UploadZone onFile={handleFile} parsing={parsing} />
              {parseError && <p className="mt-4 text-center text-red-500 text-sm">{parseError}</p>}
            </>
          ) : uploadTab === 'calibre' ? (
            <CalibreLibrary onFile={handleFile} />
          ) : uploadTab === 'library' ? (
            <GithubLibrary onFile={handleFile} />
          ) : (
            /* My Books */
            <div className="max-w-2xl">
              {/* Import */}
              <div className="mb-5 flex items-center gap-3">
                <label
                  htmlFor="bookbuddy-import"
                  className="px-3 py-1.5 bg-paper-dark text-ink text-xs font-medium rounded-lg cursor-pointer hover:bg-paper-dark/80 transition-colors border border-border"
                >
                  Import .bookbuddy
                </label>
                <input
                  id="bookbuddy-import"
                  type="file"
                  accept=".bookbuddy,.etbook"
                  className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ''; }}
                />
                {importError && <p className="text-xs text-red-400">{importError}</p>}
              </div>

              {savedBooks.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[30vh] gap-3 text-center">
                  <span className="text-4xl opacity-30">📚</span>
                  <p className="text-ink-soft font-medium font-serif">No books yet</p>
                  <p className="text-sm text-ink-dim">Books you open will appear here for quick access.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-ink-dim font-mono uppercase tracking-wider">
                      {savedBooks.length} saved book{savedBooks.length !== 1 ? 's' : ''}
                    </p>
                    {savedBooks.some((e) => {
                      const inQueue = queue.some((j) => j.title === e.title && j.author === e.author && (j.status === 'waiting' || j.status === 'running'));
                      return !inQueue && (e.chapterCount == null || e.lastAnalyzedIndex < e.chapterCount - 1);
                    }) && (
                      <button
                        onClick={() => {
                          const toAdd = savedBooks.filter((e) => {
                            const inQueue = queue.some((j) => j.title === e.title && j.author === e.author && (j.status === 'waiting' || j.status === 'running'));
                            return !inQueue && (e.chapterCount == null || e.lastAnalyzedIndex < e.chapterCount - 1);
                          });
                          if (toAdd.length === 0) return;
                          setQueue((q) => [
                            ...q,
                            ...toAdd.map((e) => ({ id: `${e.title}::${e.author}::${Date.now()}`, title: e.title, author: e.author, status: 'waiting' as const })),
                          ]);
                        }}
                        className="text-xs text-ink-dim hover:text-amber transition-colors"
                      >
                        + Queue all unfinished
                      </button>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {savedBooks.map((entry) => {
                      const analyzed = entry.lastAnalyzedIndex >= 0;
                      const queuedJob = queue.find((j) => j.title === entry.title && j.author === entry.author && (j.status === 'waiting' || j.status === 'running'));
                      const fullyProcessed = entry.chapterCount != null && entry.lastAnalyzedIndex >= entry.chapterCount - 1;
                      return (
                        <li key={`${entry.title}::${entry.author}`} className="flex items-center gap-2">
                          <button
                            onClick={() => loadBookFromMeta(entry.title, entry.author)}
                            className="flex-1 text-left px-4 py-3 bg-paper-raised border border-border rounded-xl hover:border-border/60 transition-colors"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium text-ink font-serif truncate">{entry.title}</p>
                                <p className="text-xs text-ink-soft truncate mt-0.5">{entry.author}</p>
                              </div>
                              <div className="flex-shrink-0 text-right">
                                {analyzed ? (
                                  <span className="text-xs text-amber-500/80 font-mono">
                                    Ch. {entry.lastAnalyzedIndex + 1}{entry.chapterCount ? ` / ${entry.chapterCount}` : ''} analyzed
                                  </span>
                                ) : (
                                  <span className="text-xs text-ink-dim font-mono">Not analyzed</span>
                                )}
                              </div>
                            </div>
                          </button>
                          {/* Queue button */}
                          {!fullyProcessed && (
                            <button
                              onClick={() => {
                                if (queuedJob) {
                                  // Remove from queue
                                  setQueue((q) => q.filter((j) => j.id !== queuedJob.id));
                                } else {
                                  setQueue((q) => [...q, { id: `${entry.title}::${entry.author}::${Date.now()}`, title: entry.title, author: entry.author, status: 'waiting' }]);
                                }
                              }}
                              title={queuedJob ? 'Remove from queue' : 'Add to processing queue'}
                              className={`flex-shrink-0 p-2 transition-colors text-sm ${queuedJob ? 'text-amber-400 hover:text-red-400' : 'text-ink-dim hover:text-amber'}`}
                            >
                              {queuedJob ? (queuedJob.status === 'running' ? '◌' : '⏳') : '+'}
                            </button>
                          )}
                          {analyzed && (
                            <>
                              <button
                                onClick={() => setSubmitBook({ title: entry.title, author: entry.author })}
                                title="Share to Library"
                                className="flex-shrink-0 p-2 text-ink-dim hover:text-amber transition-colors"
                              >
                                ↑
                              </button>
                              <button
                                onClick={() => exportBook(entry.title, entry.author)}
                                title="Export .bookbuddy"
                                className="flex-shrink-0 p-2 text-ink-dim hover:text-ink transition-colors"
                              >
                                ↓
                              </button>
                            </>
                          )}
                          {pendingDelete === `${entry.title}::${entry.author}` ? (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => {
                                  deleteBookState(entry.title, entry.author).catch(() => {});
                                  setPendingDelete(null);
                                  setMyBooksRev((r) => r + 1);
                                }}
                                className="text-xs px-2 py-1 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors font-medium"
                              >
                                Delete
                              </button>
                              <button
                                onClick={() => setPendingDelete(null)}
                                className="text-xs px-2 py-1 rounded-md text-ink-soft hover:text-ink transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setPendingDelete(`${entry.title}::${entry.author}`)}
                              title="Delete saved data"
                              className="flex-shrink-0 p-2 text-ink-dim hover:text-red-400 transition-colors"
                            >
                              ✕
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </main>
    );
  }

  const stored = storedRef.current;
  void parentArcsRev; // trigger re-render when parent arcs are updated
  const hasStoredState = !!stored && stored.lastAnalyzedIndex >= 0;
  const isSeriesContinuation = stored?.lastAnalyzedIndex === -1;
  const isMetaOnly = book.chapters.every((ch) => !ch.text);
  const busy = analyzing || rebuilding;
  const snapshotIndices = new Set(visibleSnapshots.map((s) => s.index));
  // Whether the displayed result is from a historical snapshot rather than the latest
  const isViewingHistory = viewingSnapshotIndex !== null;
  const effectiveBookmark = Math.max(0, Math.min(
    stored?.readingBookmark ?? stored?.lastAnalyzedIndex ?? 0,
    stored?.lastAnalyzedIndex ?? 0,
  )); // clamp bookmark to analyzed range
  // viewingSnapshotIndex is deliberately excluded: the bookmark is the spoiler ceiling.
  // When viewing a snapshot below the bookmark, panels still show data up to the bookmark.
  // When viewing beyond the bookmark (spoiler dismissed), spoilerDismissedIndex takes over.
  const currentChapterIndex = spoilerDismissedIndex ?? effectiveBookmark;

  const readingPosition: ReadingPosition | undefined = stored?.readingPosition ?? (
    stored?.readingBookmark != null ? { chapterIndex: stored.readingBookmark } : undefined
  );

  const isBeyondBookmark = stored?.readingBookmark != null && currentIndex > effectiveBookmark;
  const showSpoilerBanner = isBeyondBookmark && spoilerDismissedIndex !== currentIndex;

  return (
    <main className="h-screen flex flex-col overflow-hidden bg-paper">
      {/* Modals — unchanged */}
      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); setShowSetupPrompt(false); }} />}
      {showBookStructureEditor && book && storedRef.current?.series && (
        <BookStructureEditor
          series={storedRef.current.series}
          chapters={book.chapters.map(({ order, title, bookIndex, preview, contentType }) =>
            ({ order, title, bookIndex, preview, contentType }))}
          onSave={handleSaveSeries}
          onClose={() => setShowBookStructureEditor(false)}
          mode={bookStructureMode}
          onReextract={handleReextractTitles}
        />
      )}
      {showBookmarkModal && book && (
        <BookmarkModal
          chapters={book.chapters}
          currentBookmark={storedRef.current?.readingBookmark ?? null}
          mode={bookmarkModalMode}
          onSelect={(index) => {
            handleSetBookmark(index);
            setShowBookmarkModal(false);
          }}
          onClose={() => setShowBookmarkModal(false)}
        />
      )}
      {showTimeline && book && (
        <StoryTimeline
          snapshots={visibleSnapshots}
          chapterTitles={book.chapters.map((ch) => ch.title)}
          currentIndex={viewingSnapshotIndex ?? stored?.lastAnalyzedIndex ?? 0}
          currentResult={result ?? undefined}
          onResultEdit={applyResultEdit}
          readingPosition={readingPosition}
          onSetReadingPosition={handleSetReadingPosition}
          onClose={() => setShowTimeline(false)}
          onJumpToChapter={(i) => { handleChapterChange(i); setShowTimeline(false); }}
        />
      )}

      {/* WorkshopScreen — full-screen overlay */}
      {showWorkshop && stored && (
        <WorkshopScreen
          book={book}
          stored={stored}
          result={result}
          currentIndex={currentIndex}
          onClose={() => setShowWorkshop(false)}
          onChapterChange={handleChapterChange}
          onAnalyze={handleAnalyze}
          onCancelAnalyze={() => { analyzeCancelRef.current = true; }}
          onRebuild={handleRebuild}
          onCancelRebuild={() => { rebuildCancelRef.current = true; }}
          onProcessBook={handleProcessBook}
          onDeleteSnapshot={handleDeleteSnapshot}
          onSetBookmark={handleSetBookmark}
          onSetRange={setChapterRange}
          analyzing={analyzing}
          rebuilding={rebuilding}
          rebuildProgress={rebuildProgress}
          chapterRange={chapterRange}
          snapshotIndices={snapshotIndices}
          visibleChapterOrders={visibleChapterOrders}
          isMetaOnly={isMetaOnly}
          needsSetup={needsSetup}
          onCompleteSetup={completeSetup}
          derived={derived}
          onResultEdit={applyResultEdit}
          currentChapterIndex={currentChapterIndex}
          onSaveSeries={handleSaveSeries}
          onReextractTitles={handleReextractTitles}
          savedBooks={listSavedBooks()}
          onLoadBook={loadBookFromMeta}
          onDeleteBook={(title, author) => { deleteBookState(title, author).catch(() => {}); }}
          onImportFile={handleFile}
          queue={queue}
          onRemoveJob={(id) => setQueue((q) => q.filter((j) => j.id !== id))}
          onCancelCurrentJob={() => { queueCancelRef.current = true; }}
          onClearDone={() => setQueue((q) => q.filter((j) => j.status !== 'done' && j.status !== 'error'))}
        />
      )}

      {/* ExploreHeader */}
      <ExploreHeader
        bookTitle={book.title}
        currentChapterIndex={currentIndex}
        totalChapters={book.chapters.length}
        onChapterPillTap={() => {}}
        onOpenWorkshop={() => setShowWorkshop(true)}
        onOpenChat={() => setShowChat(true)}
        onOpenSettings={() => setShowSettings(true)}
        onChangeBook={() => { setBook(null); setResult(null); storedRef.current = null; seriesBaseRef.current = null; }}
        onToggleTheme={toggleTheme}
        isDark={isDark}
        hasStoredState={hasStoredState}
      />

      {/* RecapStrip */}
      {result?.summary && (
        <RecapStrip summary={result.summary} onOpenTimeline={() => setShowTimeline(true)} />
      )}

      {/* Main scrollable content area */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Snapshot navigator */}
        {stored && (
          <SnapshotNav
            snapshots={visibleSnapshots}
            chapters={book.chapters}
            viewingSnapshotIndex={viewingSnapshotIndex}
            stored={stored}
            onNavigate={(snapIdx, chIdx, res) => {
              setViewingSnapshotIndex(snapIdx);
              setCurrentIndex(chIdx);
              setResult(res);
              setSpoilerDismissedIndex(null);
            }}
          />
        )}

        {/* Spoiler banner */}
        {showSpoilerBanner && (
          <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex-shrink-0">
            <span className="text-amber-500 text-sm flex-shrink-0">&#9888;</span>
            <p className="flex-1 text-sm text-ink-soft">
              Chapter {currentIndex + 1} is past your bookmark (Ch. {effectiveBookmark + 1}).
            </p>
            <button
              onClick={handleDismissSpoiler}
              className="flex-shrink-0 px-3 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-600 dark:text-amber-400 rounded-lg transition-colors"
            >
              Show anyway
            </button>
          </div>
        )}

        {/* Empty state */}
        {!result && !busy && !rebuildProgress && (
          <div className="flex flex-col items-center justify-center flex-1 text-center gap-3">
            <span className="text-5xl opacity-20">{isSeriesContinuation ? '📚' : '⌖'}</span>
            <p className="text-ink-soft font-medium">
              {isSeriesContinuation
                ? 'Series characters loaded. Select a chapter and update.'
                : 'Select your chapter and analyze.'}
            </p>
            <p className="text-sm text-ink-dim max-w-xs">
              {isSeriesContinuation
                ? 'Only new chapters will be read — your existing characters carry forward.'
                : "Only what you've read is sent to the model — no spoilers."}
            </p>
          </div>
        )}

        {/* Setup prompt */}
        {showSetupPrompt && (
          <SetupPrompt
            onComplete={() => { setShowSetupPrompt(false); handleAnalyze(); }}
            onOpenSettings={() => { setShowSetupPrompt(false); setShowSettings(true); }}
          />
        )}

        {/* Progress indicator */}
        {(analyzing || rebuilding) && rebuildProgress && (
          <div className={`mb-4 rounded-xl border px-4 py-3 ${rebuilding ? 'border-violet-500/20 bg-violet-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
            <div className="flex items-center gap-3">
              <div className={`w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin flex-shrink-0 ${rebuilding ? 'border-violet-500' : 'border-amber-500'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink truncate">
                    {rebuilding ? 'Rebuilding' : 'Analyzing'} · {rebuildProgress.current}/{rebuildProgress.total}
                    {rebuildProgress.chapterTitle && (
                      <span className="ml-2 font-normal text-ink-soft">
                        {rebuildProgress.chapterTitle}
                      </span>
                    )}
                  </p>
                  <button
                    onClick={() => { if (rebuilding) rebuildCancelRef.current = true; else analyzeCancelRef.current = true; }}
                    className="flex-shrink-0 text-xs text-ink-dim hover:text-red-400 dark:hover:text-red-500 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <div className="mt-2 w-full bg-paper-dark rounded-full h-0.5">
                  <div
                    className={`h-0.5 rounded-full transition-all duration-300 ${rebuilding ? 'bg-violet-500' : 'bg-amber-500'}`}
                    style={{ width: `${(rebuildProgress.current / rebuildProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab content */}
        {result && (
          <div>
            {tab === 'characters' && (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <input
                    type="search"
                    placeholder="Search..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="bg-paper border border-border rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim font-serif focus:outline-none focus:border-rust min-w-36 flex-1"
                  />
                  <div className="flex gap-1.5 flex-wrap">
                    {(['all', 'main', 'secondary', 'minor'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                          filter === f ? 'bg-rust/10 text-rust' : 'text-ink-soft border border-border hover:border-rust/30'
                        }`}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {displayed.map((character) => (
                    <NewCharacterCard
                      key={character.name}
                      character={character}
                      snapshots={visibleSnapshots}
                      chapterTitles={book.chapters.map((ch) => ch.title)}
                      currentResult={result}
                      onResultEdit={applyResultEdit}
                      currentChapterIndex={currentChapterIndex}
                      onChapterJump={handleChapterChange}
                    />
                  ))}
                </div>
              </>
            )}

            {tab === 'locations' && result?.locations && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {result.locations.map((location) => (
                  <NewLocationCard
                    key={location.name}
                    location={location}
                    characters={characters}
                    isCurrentChapter={false}
                    snapshots={visibleSnapshots}
                    chapterTitles={book.chapters.map((ch) => ch.title)}
                    currentResult={result}
                    onResultEdit={applyResultEdit}
                    currentChapterIndex={currentChapterIndex}
                  />
                ))}
              </div>
            )}

            {tab === 'arcs' && result?.arcs && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {result.arcs.map((arc) => (
                  <ArcCard
                    key={arc.name}
                    arc={arc}
                    snapshots={visibleSnapshots}
                    chapterTitles={book.chapters.map((ch) => ch.title)}
                    currentResult={result}
                    onResultEdit={applyResultEdit}
                    currentChapterIndex={currentChapterIndex}
                  />
                ))}
              </div>
            )}

            {tab === 'map' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <MapBoard
                  characters={characters}
                  arcs={result?.arcs}
                  locationInfos={result?.locations}
                  bookTitle={book.title}
                  mapState={mapState}
                  snapshots={stored?.snapshots ?? []}
                  currentResult={result ?? undefined}
                  onResultEdit={applyResultEdit}
                  resolvedCharacters={derived.resolvedCharacters}
                  locationAliasMap={derived.locationAliasMap}
                  locationGroups={derived.locationGroups}
                  currentChapterIndex={currentChapterIndex}
                  parentArcs={stored?.parentArcs}
                  onMapStateChange={(state) => {
                    setMapState(state);
                    persistMapState(book.title, book.author, state);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* PullUpSheet — bottom chapter navigation */}
      <PullUpSheet
        chapters={book.chapters}
        currentIndex={currentIndex}
        snapshots={visibleSnapshots}
        onChapterSelect={(i) => handleChapterChange(i)}
        visibleChapterOrders={visibleChapterOrders}
      />

      {/* BottomNav — 4-tab bar */}
      <BottomNav activeTab={tab} onChange={setTab} />

      {/* ChatPanel, SearchFAB, SearchSheet, search entity modals — unchanged */}
      {showChat && result && stored && stored.lastAnalyzedIndex >= 0 && (
        <ChatPanel
          bookTitle={book.title}
          bookAuthor={book.author}
          lastAnalyzedIndex={stored.lastAnalyzedIndex}
          currentChapterTitle={book.chapters[stored.lastAnalyzedIndex]?.title ?? `Chapter ${stored.lastAnalyzedIndex + 1}`}
          totalChapters={book.chapters.length}
          result={result}
          snapshots={stored.snapshots ?? []}
          chapterTitles={book.chapters.map((ch) => ch.title)}
          onClose={() => setShowChat(false)}
        />
      )}
      {result && stored && !showSearch && !searchEntity && (
        <SearchFAB onClick={() => setShowSearch(true)} />
      )}
      {result && stored && (
        <SearchSheet
          isOpen={showSearch}
          onClose={() => setShowSearch(false)}
          onEntitySelect={handleSearchEntitySelect}
          characters={derived.aggregated.characters}
          locations={derived.aggregated.locations}
          arcs={derived.aggregated.arcs}
        />
      )}
      {searchEntity?.type === 'character' && (() => {
        let char = result?.characters.find((c) => c.name === searchEntity.name);
        if (!char) {
          char = derived.aggregated.characters.find((e) => e.character.name === searchEntity.name)?.character;
        }
        if (!char) return null;
        const inCurrent = !!result?.characters.find((c) => c.name === searchEntity.name);
        return (
          <CharacterModal
            character={char}
            snapshots={stored?.snapshots ?? []}
            chapterTitles={book?.chapters.map((ch) => ch.title) ?? []}
            currentResult={inCurrent ? result ?? undefined : undefined}
            onResultEdit={inCurrent ? applyResultEdit : undefined}
            currentChapterIndex={currentChapterIndex}
            onClose={() => setSearchEntity(null)}
            onEntityClick={(type, name) => {
              setSearchEntity({ type, name });
            }}
          />
        );
      })()}
      {searchEntity?.type === 'location' && (() => {
        const inCurrent = result?.locations?.some((l) => l.name === searchEntity.name) ?? false;
        return (
          <LocationModal
            locationName={searchEntity.name}
            snapshots={stored?.snapshots ?? []}
            chapterTitles={book?.chapters.map((ch) => ch.title) ?? []}
            currentResult={inCurrent ? result ?? undefined : undefined}
            onResultEdit={inCurrent ? applyResultEdit : undefined}
            currentChapterIndex={currentChapterIndex}
            onClose={() => setSearchEntity(null)}
            onEntityClick={(type, name) => {
              setSearchEntity({ type, name });
            }}
          />
        );
      })()}
      {searchEntity?.type === 'arc' && (() => {
        const inCurrent = result?.arcs?.some((a) => a.name === searchEntity.name) ?? false;
        return (
          <NarrativeArcModal
            arcName={searchEntity.name}
            snapshots={stored?.snapshots ?? []}
            chapterTitles={book?.chapters.map((ch) => ch.title) ?? []}
            currentResult={inCurrent ? result ?? undefined : undefined}
            onResultEdit={inCurrent ? applyResultEdit : undefined}
            currentChapterIndex={currentChapterIndex}
            onClose={() => setSearchEntity(null)}
            onEntityClick={(type, name) => {
              setSearchEntity({ type, name });
            }}
          />
        );
      })()}
    </main>
  );
}
