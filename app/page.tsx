'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseEpub } from '@/lib/epub-parser';
import type { AnalysisResult, Character, MapState, ParsedEbook, PinUpdates, QueueJob, Snapshot } from '@/types';
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
import { saveChapters, loadChapters, deleteChapters } from '@/lib/chapter-storage';
import ProcessingQueue from '@/components/ProcessingQueue';
import ChatPanel from '@/components/ChatPanel';
import ArcsPanel from '@/components/ArcsPanel';
import EntityManager from '@/components/EntityManager';
import { buildShareMarkdown, shareReadingContext } from '@/lib/share-context';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import StoryTimeline from '@/components/StoryTimeline';
import WelcomeBanner from '@/components/WelcomeBanner';
import LibrarySubmitModal from '@/components/LibrarySubmitModal';
import { useDerivedEntities } from '@/lib/use-derived-entities';

type SortKey = 'importance' | 'name' | 'status';
type MainTab = 'characters' | 'locations' | 'map' | 'arcs' | 'manage';

const IMPORTANCE_ORDER: Record<Character['importance'], number> = {
  main: 0,
  secondary: 1,
  minor: 2,
};

interface BookMeta {
  chapters: Array<{ id: string; title: string; order: number; bookIndex?: number; bookTitle?: string }>;
  books?: string[];
}

interface StoredBookState {
  lastAnalyzedIndex: number; // -2 = meta only, -1 = series carry-forward, ≥0 = analyzed
  result: AnalysisResult;
  snapshots: Snapshot[];
  excludedBooks?: number[];
  excludedChapters?: number[];  // global chapter indices excluded from analysis
  chapterRange?: { start: number; end: number }; // inclusive chapter index range for analysis
  bookMeta?: BookMeta;
  readingBookmark?: number; // user-set "read up to" chapter index (inclusive)
}

interface SavedBookEntry {
  title: string;
  author: string;
  lastAnalyzedIndex: number;
  chapterCount?: number;
}

function storageKey(title: string, author: string) {
  return `bookbuddy::${title}::${author}`;
}

function loadStored(title: string, author: string): StoredBookState | null {
  try {
    // Migrate from legacy key if new key not yet written
    const raw = localStorage.getItem(storageKey(title, author))
      ?? localStorage.getItem(`ebook-tracker::${title}::${author}`);
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

function deleteStored(title: string, author: string) {
  localStorage.removeItem(storageKey(title, author));
  localStorage.removeItem(`ebook-tracker::${title}::${author}`);
  localStorage.removeItem(mapStorageKey(title, author));
  deleteChapters(title, author).catch(() => {});
}

function mapStorageKey(title: string, author: string) {
  return `bookbuddy-map::${title}::${author}`;
}

function loadMapState(title: string, author: string): MapState | null {
  try {
    const raw = localStorage.getItem(mapStorageKey(title, author));
    return raw ? (JSON.parse(raw) as MapState) : null;
  } catch { return null; }
}

function saveMapState(title: string, author: string, state: MapState) {
  try {
    localStorage.setItem(mapStorageKey(title, author), JSON.stringify(state));
  } catch { /* ignore */ }
}

interface BookBuddyExport {
  version: 2;
  title: string;
  author: string;
  state: StoredBookState;
  mapState: MapState | null;
}

function exportBook(title: string, author: string, liveParsed?: ParsedEbook) {
  const state = loadStored(title, author);
  if (!state) return;
  // Synthesize bookMeta from live parsed book if it wasn't saved yet
  if (!state.bookMeta && liveParsed && liveParsed.title === title && liveParsed.author === author) {
    state.bookMeta = {
      chapters: liveParsed.chapters.map(({ id, title: t, order, bookIndex, bookTitle }) => ({ id, title: t, order, bookIndex, bookTitle })),
      books: liveParsed.books,
    };
  }
  const mapState = loadMapState(title, author);
  const payload: BookBuddyExport = { version: 2, title, author, state, mapState };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title} — ${author}.bookbuddy`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBookBuddy(file: File): Promise<{ title: string; author: string }> {
  const text = await file.text();
  const payload = JSON.parse(text) as Partial<BookBuddyExport>;
  if (!payload.title || !payload.author || !payload.state) {
    throw new Error('Invalid or unrecognised .bookbuddy file.');
  }
  saveStored(payload.title, payload.author, payload.state);
  if (payload.mapState) saveMapState(payload.title, payload.author, payload.mapState);
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
function upsertSnapshot(snapshots: Snapshot[], index: number, result: AnalysisResult, model?: string, appVersion?: string): Snapshot[] {
  const without = snapshots.filter((s) => s.index !== index);
  return [...without, { index, result, ...(model ? { model } : {}), ...(appVersion ? { appVersion } : {}) }];
}

function listSavedBooks(excludeTitle?: string, excludeAuthor?: string): SavedBookEntry[] {
  const results: SavedBookEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('bookbuddy::') && !key?.startsWith('ebook-tracker::')) continue;
      const [, title, author] = key.split('::');
      if (title === excludeTitle && author === excludeAuthor) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = JSON.parse(raw) as StoredBookState;
      results.push({ title, author, lastAnalyzedIndex: state.lastAnalyzedIndex, chapterCount: state.bookMeta?.chapters.length });
    }
  } catch { /* ignore */ }
  return results.sort((a, b) => b.lastAnalyzedIndex - a.lastAnalyzedIndex);
}

const IS_MOBILE = process.env.NEXT_PUBLIC_MOBILE === 'true';
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
): Promise<{ result: AnalysisResult; model: string }> {
  if (IS_MOBILE) {
    const { analyzeChapterClient } = await import('@/lib/ai-client');
    const result = await analyzeChapterClient(bookTitle, bookAuthor, chapter, previousResult);
    return { result, model: 'mobile' };
  }

  // Include client-side AI settings so server can use them when env vars aren't set
  let aiSettings: Record<string, string> = {};
  try {
    const { loadAiSettings } = await import('@/lib/ai-client');
    const s = loadAiSettings();
    if (s.provider) aiSettings._provider = s.provider;
    if (s.anthropicKey) aiSettings._apiKey = s.anthropicKey;
    if (s.ollamaUrl) aiSettings._ollamaUrl = s.ollamaUrl;
    if (s.model) aiSettings._model = s.model;
  } catch { /* ignore — server will use env vars */ }

  const body = previousResult
    ? { newChapters: [chapter], previousResult, currentChapterTitle: chapter.title, bookTitle, bookAuthor, ...aiSettings }
    : { chaptersRead: [chapter], allChapterTitles, currentChapterTitle: chapter.title, bookTitle, bookAuthor, ...aiSettings };

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as AnalysisResult & { _model?: string };
  if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? 'Analysis failed.');
  const { _model, ...result } = data;
  return { result: result as AnalysisResult, model: _model ?? 'unknown' };
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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

  const [excludedBooks, setExcludedBooks] = useState<Set<number>>(new Set());
  const [excludedChapters, setExcludedChapters] = useState<Set<number>>(new Set());
  const [chapterRange, setChapterRangeState] = useState<{ start: number; end: number } | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [mapState, setMapState] = useState<MapState | null>(null);

  function toggleBook(bookIndex: number) {
    setExcludedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookIndex)) next.delete(bookIndex); else next.add(bookIndex);
      if (book && storedRef.current) {
        const updated = { ...storedRef.current, excludedBooks: [...next] };
        storedRef.current = updated;
        saveStored(book.title, book.author, updated);
      }
      return next;
    });
  }

  function toggleChapter(chapterIndex: number) {
    setExcludedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapterIndex)) next.delete(chapterIndex); else next.add(chapterIndex);
      if (book && storedRef.current) {
        const updated = { ...storedRef.current, excludedChapters: [...next] };
        storedRef.current = updated;
        saveStored(book.title, book.author, updated);
      }
      return next;
    });
  }

  function setChapterRange(range: { start: number; end: number } | null) {
    setChapterRangeState(range);
    if (book && storedRef.current) {
      const updated: StoredBookState = { ...storedRef.current };
      if (range) updated.chapterRange = range; else delete updated.chapterRange;
      storedRef.current = updated;
      saveStored(book.title, book.author, updated);
    }
  }

  function handleSetBookmark(index: number | null) {
    if (!book || !storedRef.current) return;
    const stored = storedRef.current;
    const updated: StoredBookState = { ...stored, readingBookmark: index ?? undefined };
    // Clean up: if readingBookmark is undefined, delete the key entirely
    if (index == null) delete (updated as any).readingBookmark;
    storedRef.current = updated;
    saveStored(book.title, book.author, updated);

    // Load the appropriate snapshot for the new bookmark position
    const bookmark = index ?? stored.lastAnalyzedIndex;
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

  // Sync map state across browser tabs via the storage event
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (!book || !e.key) return;
      if (e.key === mapStorageKey(book.title, book.author)) {
        setMapState(e.newValue ? (JSON.parse(e.newValue) as MapState) : null);
      }
      if (e.key === storageKey(book.title, book.author) && e.newValue) {
        const updated = JSON.parse(e.newValue) as StoredBookState;
        storedRef.current = updated;
        if (!playing) {
          setResult(updated.result);
          setCurrentIndex(updated.lastAnalyzedIndex);
          setViewingSnapshotIndex(null);
        }
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [book, playing]);

  const storedRef = useRef<StoredBookState | null>(null);
  const seriesBaseRef = useRef<AnalysisResult | null>(null);
  const mapStateRef = useRef<MapState | null>(null);
  useEffect(() => { mapStateRef.current = mapState; }, [mapState]);

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
      const updated: StoredBookState = { ...cur, result: newResult, snapshots };
      storedRef.current = updated;
      saveStored(book.title, book.author, updated);
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
        saveMapState(book.title, book.author, next);
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
        const stored = loadStored(title, author);
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
        const excludedBookSet = new Set(stored.excludedBooks ?? []);
        const excludedChapterSet = new Set(stored.excludedChapters ?? []);
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
          if (ch.bookIndex !== undefined && excludedBookSet.has(ch.bookIndex)) continue;
          if (excludedChapterSet.has(i) || isFrontMatter(ch)) {
            if (accumulated) {
              snapshots = upsertSnapshot(snapshots, i, accumulated);
              latestStored = { ...latestStored, lastAnalyzedIndex: i, result: accumulated, snapshots };
              saveStored(title, author, latestStored);
              if (bookRef.current?.title === title && bookRef.current?.author === author) {
                storedRef.current = latestStored;
              }
            }
            continue;
          }

          const { result: chResult, model: chModel } = await analyzeChapter(title, author, { title: ch.title, text: ch.text }, accumulated, chapters.map((c) => c.title));
          accumulated = chResult;
          recentText += `\n=== ${ch.title} ===\n${ch.text}`;
          if (recentText.length > MAX_RECENT_TEXT) recentText = recentText.slice(-MAX_RECENT_TEXT);
          snapshots = upsertSnapshot(snapshots, i, accumulated, chModel, APP_VERSION);
          latestStored = { ...latestStored, lastAnalyzedIndex: i, result: accumulated, snapshots };
          saveStored(title, author, latestStored);

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
              saveStored(title, author, latestStored);
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
            saveStored(title, author, latestStored);
            if (bookRef.current?.title === title && bookRef.current?.author === author) {
              storedRef.current = latestStored;
              setResult(accumulated);
            }
          } catch (reconcileErr) {
            console.warn('[queue] Final reconciliation failed, keeping unreconciled result:', reconcileErr);
          }
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

  function activateBook(parsed: ParsedEbook, initialStored: StoredBookState | null) {
    const bookMeta: BookMeta = {
      chapters: parsed.chapters.map(({ id, title, order, bookIndex, bookTitle }) => ({ id, title, order, bookIndex, bookTitle })),
      books: parsed.books,
    };
    const stateToSave: StoredBookState = initialStored
      ? { ...initialStored, bookMeta }
      : { lastAnalyzedIndex: -2, result: { characters: [], summary: '' }, snapshots: [], bookMeta };
    storedRef.current = stateToSave;
    saveStored(parsed.title, parsed.author, stateToSave);
    // Persist chapter texts in IndexedDB so re-upload is not required next session
    const chaptersWithText = parsed.chapters.filter((ch) => ch.text).map(({ id, text }) => ({ id, text }));
    if (chaptersWithText.length > 0) {
      saveChapters(parsed.title, parsed.author, chaptersWithText).catch(() => {});
    }
    seriesBaseRef.current = initialStored?.lastAnalyzedIndex === -1 ? initialStored.result : null;
    setExcludedBooks(initialStored?.excludedBooks ? new Set(initialStored.excludedBooks) : new Set());
    setExcludedChapters(initialStored?.excludedChapters ? new Set(initialStored.excludedChapters) : new Set());
    setChapterRangeState(initialStored?.chapterRange ?? null);
    setMapState(loadMapState(parsed.title, parsed.author));
    setBook(parsed);
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
  }

  async function loadBookFromMeta(title: string, author: string) {
    const stored = loadStored(title, author);
    if (!stored) return;
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
    activateBook(parsed, stored);
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
      const ownStored = loadStored(parsed.title, parsed.author);
      if (ownStored) { activateBook(parsed, ownStored); return; }
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

  /** Indices of chapters in [from, to] that are neither excluded nor front-matter. */
  function analyzableIndices(from: number, to: number): number[] {
    if (!book) return [];
    const result: number[] = [];
    for (let i = from; i <= to; i++) {
      const ch = book.chapters[i];
      if (!ch) continue;
      if (ch.bookIndex !== undefined && excludedBooks.has(ch.bookIndex)) continue;
      if (excludedChapters.has(i) || isFrontMatter(ch)) continue;
      result.push(i);
    }
    return result;
  }

  const handleAnalyze = useCallback(async () => {
    if (!book || needsSetup) return;
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
        const { result: chapterResult, model: chapterModel } = await analyzeChapter(book.title, book.author, { title: ch.title, text: ch.text }, accumulated, book.chapters.map((c) => c.title));
        accumulated = chapterResult;
        snapshots = upsertSnapshot(snapshots, i, accumulated, chapterModel, APP_VERSION);
        const partial: StoredBookState = { ...analyzeBase, lastAnalyzedIndex: i, result: accumulated, snapshots };
        storedRef.current = partial;
        saveStored(book.title, book.author, partial);
        setResult(accumulated);
        setViewingSnapshotIndex(null);
      }
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      setAnalyzing(false);
      setRebuildProgress(null);
      analyzeCancelRef.current = false;
    }
  }, [book, currentIndex, excludedBooks, excludedChapters, chapterRange, needsSetup]);

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
        const { result: rebuildResult, model: rebuildModel } = await analyzeChapter(book.title, book.author, { title: ch.title, text: ch.text }, accumulated, book.chapters.map((c) => c.title));
        accumulated = rebuildResult;
        snapshots = upsertSnapshot(snapshots, i, accumulated, rebuildModel, APP_VERSION);
        const partial: StoredBookState = { ...rebuildBase, lastAnalyzedIndex: i, result: accumulated, snapshots };
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
  }, [book, currentIndex, excludedBooks, excludedChapters, chapterRange]);

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
        const { result: chResult, model: chModel } = await analyzeChapter(book.title, book.author, { title: ch.title, text: ch.text }, accumulated, book.chapters.map((c) => c.title));
        accumulated = chResult;
        snapshots = upsertSnapshot(snapshots, i, accumulated, chModel, APP_VERSION);
        const partial: StoredBookState = { ...processBase, lastAnalyzedIndex: i, result: accumulated, snapshots };
        storedRef.current = partial;
        saveStored(book.title, book.author, partial);
        setResult(accumulated);
        setCurrentIndex(i);
        setViewingSnapshotIndex(null);
      }
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Process failed.');
    } finally {
      setRebuilding(false);
      setRebuildProgress(null);
      rebuildCancelRef.current = false;
    }
  }, [book, excludedBooks, excludedChapters, chapterRange]);

  const handleDeleteSnapshot = useCallback((index: number) => {
    if (!book || !storedRef.current) return;
    const cur = storedRef.current;
    // Remove snapshot at index and all later ones (they're based on the deleted analysis)
    const newSnapshots = cur.snapshots.filter((s) => s.index < index);
    if (newSnapshots.length === 0) {
      const updated: StoredBookState = { lastAnalyzedIndex: -2, result: { characters: [], summary: '' }, snapshots: [], bookMeta: cur.bookMeta };
      storedRef.current = updated;
      saveStored(book.title, book.author, updated);
      setResult(null);
      setViewingSnapshotIndex(null);
      return;
    }
    const sortedSnaps = [...newSnapshots].sort((a, b) => b.index - a.index);
    const newLastIdx = sortedSnaps[0].index;
    const newResult = sortedSnaps[0].result;
    const updated: StoredBookState = { lastAnalyzedIndex: newLastIdx, result: newResult, snapshots: newSnapshots, bookMeta: cur.bookMeta };
    storedRef.current = updated;
    saveStored(book.title, book.author, updated);
    setResult(newResult);
    setViewingSnapshotIndex(null);
    if (currentIndex > newLastIdx) setCurrentIndex(newLastIdx);
  }, [book, currentIndex]);

  const characters = result?.characters ?? [];
  const derived = useDerivedEntities(storedRef.current?.snapshots ?? [], result ?? null);
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
    void myBooksRev; // used to trigger re-render after deletion
    const savedBooks = listSavedBooks();
    return (
      <main className="min-h-dvh flex flex-col">
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        {submitBook && <LibrarySubmitModal title={submitBook.title} author={submitBook.author} onClose={() => setSubmitBook(null)} />}
        <div className="flex items-end border-b border-stone-200 dark:border-zinc-800 px-2 sm:px-6 pt-4 sm:pt-6 overflow-x-auto scrollbar-none">
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
                  : 'border-transparent text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
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
              className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
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
                  className="px-3 py-1.5 bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 text-xs font-medium rounded-lg cursor-pointer hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors border border-stone-300 dark:border-zinc-700"
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
                  <p className="text-stone-500 dark:text-zinc-400 font-medium">No books yet</p>
                  <p className="text-sm text-stone-400 dark:text-zinc-600">Books you open will appear here for quick access.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider">
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
                        className="text-xs text-stone-400 dark:text-zinc-600 hover:text-amber-400 transition-colors"
                      >
                        + Queue all unfinished
                      </button>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {savedBooks.map((entry) => {
                      const stored = loadStored(entry.title, entry.author);
                      const analyzed = entry.lastAnalyzedIndex >= 0;
                      const queuedJob = queue.find((j) => j.title === entry.title && j.author === entry.author && (j.status === 'waiting' || j.status === 'running'));
                      const fullyProcessed = entry.chapterCount != null && entry.lastAnalyzedIndex >= entry.chapterCount - 1;
                      return (
                        <li key={`${entry.title}::${entry.author}`} className="flex items-center gap-2">
                          <button
                            onClick={() => loadBookFromMeta(entry.title, entry.author)}
                            disabled={!stored}
                            className="flex-1 text-left px-4 py-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl hover:border-stone-300 dark:hover:border-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium text-stone-800 dark:text-zinc-200 truncate">{entry.title}</p>
                                <p className="text-xs text-stone-400 dark:text-zinc-500 truncate mt-0.5">{entry.author}</p>
                              </div>
                              <div className="flex-shrink-0 text-right">
                                {analyzed ? (
                                  <span className="text-xs text-amber-500/80">
                                    Ch. {entry.lastAnalyzedIndex + 1}{entry.chapterCount ? ` / ${entry.chapterCount}` : ''} analyzed
                                  </span>
                                ) : (
                                  <span className="text-xs text-stone-400 dark:text-zinc-600">Not analyzed</span>
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
                              className={`flex-shrink-0 p-2 transition-colors text-sm ${queuedJob ? 'text-amber-400 hover:text-red-400' : 'text-stone-300 dark:text-zinc-700 hover:text-amber-400'}`}
                            >
                              {queuedJob ? (queuedJob.status === 'running' ? '◌' : '⏳') : '+'}
                            </button>
                          )}
                          {analyzed && (
                            <>
                              <button
                                onClick={() => setSubmitBook({ title: entry.title, author: entry.author })}
                                title="Share to Library"
                                className="flex-shrink-0 p-2 text-stone-400 dark:text-zinc-600 hover:text-amber-400 transition-colors"
                              >
                                ↑
                              </button>
                              <button
                                onClick={() => exportBook(entry.title, entry.author)}
                                title="Export .bookbuddy"
                                className="flex-shrink-0 p-2 text-stone-400 dark:text-zinc-600 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
                              >
                                ↓
                              </button>
                            </>
                          )}
                          {pendingDelete === `${entry.title}::${entry.author}` ? (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => {
                                  deleteStored(entry.title, entry.author);
                                  setPendingDelete(null);
                                  setMyBooksRev((r) => r + 1);
                                }}
                                className="text-xs px-2 py-1 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors font-medium"
                              >
                                Delete
                              </button>
                              <button
                                onClick={() => setPendingDelete(null)}
                                className="text-xs px-2 py-1 rounded-md text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setPendingDelete(`${entry.title}::${entry.author}`)}
                              title="Delete saved data"
                              className="flex-shrink-0 p-2 text-stone-300 dark:text-zinc-700 hover:text-red-400 transition-colors"
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
  const hasStoredState = !!stored && stored.lastAnalyzedIndex >= 0;
  const isSeriesContinuation = stored?.lastAnalyzedIndex === -1;
  const isMetaOnly = book.chapters.every((ch) => !ch.text);
  const busy = analyzing || rebuilding;
  const snapshotIndices = new Set((stored?.snapshots ?? []).map((s) => s.index));
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

  return (
    <main className="h-screen flex flex-col overflow-hidden">
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showTimeline && book && (
        <StoryTimeline
          snapshots={stored?.snapshots ?? []}
          chapterTitles={book.chapters.map((ch) => ch.title)}
          currentIndex={viewingSnapshotIndex ?? stored?.lastAnalyzedIndex ?? 0}
          currentResult={result ?? undefined}
          onResultEdit={applyResultEdit}
          onClose={() => setShowTimeline(false)}
          onJumpToChapter={(i) => { handleChapterChange(i); setShowTimeline(false); }}
        />
      )}
      <header className="bg-white dark:bg-zinc-900 border-b border-stone-200 dark:border-zinc-800 px-4 py-3 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {/* Hamburger — mobile only */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden flex-shrink-0 w-9 h-9 flex items-center justify-center text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 transition-colors rounded-lg"
            aria-label="Open chapter list"
          >
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
              <rect width="18" height="2" rx="1" fill="currentColor"/>
              <rect y="6" width="18" height="2" rx="1" fill="currentColor"/>
              <rect y="12" width="18" height="2" rx="1" fill="currentColor"/>
            </svg>
          </button>
          <span className="text-xl flex-shrink-0">📖</span>
          <div className="min-w-0">
            <h1 className="font-bold text-stone-900 dark:text-zinc-100 leading-tight truncate text-sm sm:text-base">{book.title}</h1>
            <p className="text-xs text-stone-400 dark:text-zinc-500 truncate">{book.author}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <ProcessingQueue
            jobs={queue}
            onRemove={(id) => setQueue((q) => q.filter((j) => j.id !== id))}
            onCancelCurrent={() => { queueCancelRef.current = true; }}
            onClearDone={() => setQueue((q) => q.filter((j) => j.status !== 'done' && j.status !== 'error'))}
          />
          {isSeriesContinuation && <span className="hidden sm:inline text-xs text-violet-400 font-medium">Series mode</span>}
          {hasStoredState && <span className="hidden md:inline text-xs text-stone-400 dark:text-zinc-600">Saved · ch.{stored.lastAnalyzedIndex + 1}</span>}
          {hasStoredState && (
            <button
              onClick={() => exportBook(book.title, book.author, book)}
              className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
              title="Export .bookbuddy file"
            >
              Export
            </button>
          )}
          {hasStoredState && stored.lastAnalyzedIndex >= 0 && (
            <button
              onClick={handleShare}
              className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
              title="Share reading context with any AI assistant (Gemini, ChatGPT, Claude…)"
            >
              {shareLabel}
            </button>
          )}
          {hasStoredState && (
            <button
              onClick={() => setShowChat(true)}
              className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
              title="Ask your AI assistant about the book"
            >
              💬
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
            title="AI Settings"
          >
            ⚙
          </button>
          <button
            onClick={toggleTheme}
            className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? '☀︎' : '◗'}
          </button>
          <button
            onClick={() => { setBook(null); setResult(null); storedRef.current = null; seriesBaseRef.current = null; }}
            className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors whitespace-nowrap"
          >
            Change book
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Mobile sidebar backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <aside className={`
          fixed inset-y-0 left-0 z-40 w-72 bg-white dark:bg-zinc-900 border-r border-stone-200 dark:border-zinc-800 p-4 overflow-y-auto
          transform transition-transform duration-200 ease-in-out
          lg:relative lg:w-64 lg:translate-x-0 lg:z-auto lg:flex-shrink-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          {/* Close button — mobile only */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden mb-3 ml-auto flex items-center gap-1.5 text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
          >
            Close ✕
          </button>
          <ChapterSelector
            chapters={book.chapters}
            currentIndex={currentIndex}
            onChange={(i) => { handleChapterChange(i); setSidebarOpen(false); }}
            onAnalyze={handleAnalyze}
            onCancelAnalyze={() => { analyzeCancelRef.current = true; }}
            onRebuild={handleRebuild}
            onCancelRebuild={() => { rebuildCancelRef.current = true; }}
            onProcessBook={handleProcessBook}
            analyzing={analyzing}
            rebuilding={rebuilding}
            rebuildProgress={rebuildProgress}
            lastAnalyzedIndex={stored?.lastAnalyzedIndex ?? null}
            snapshotIndices={snapshotIndices}
            excludedBooks={excludedBooks}
            onToggleBook={toggleBook}
            excludedChapters={excludedChapters}
            onToggleChapter={toggleChapter}
            chapterRange={chapterRange}
            onSetRange={setChapterRange}
            onDeleteSnapshot={handleDeleteSnapshot}
            metaOnly={isMetaOnly}
            needsSetup={needsSetup}
            onCompleteSetup={completeSetup}
          />
          {analyzeError && <p className="mt-3 text-xs text-red-500 text-center">{analyzeError}</p>}
        </aside>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col">
          {/* Prompt to upload EPUB when no chapter data is available */}
          {isMetaOnly && book.chapters.length === 0 && (
            <label
              htmlFor="epub-reupload"
              className="flex items-center gap-3 mb-4 px-4 py-3 bg-amber-950/40 border border-amber-800/50 rounded-xl cursor-pointer hover:bg-amber-950/60 transition-colors flex-shrink-0"
            >
              <span className="text-amber-400 text-lg flex-shrink-0">📂</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-300">Upload EPUB to enable analysis</p>
                <p className="text-xs text-amber-600 mt-0.5">This book was imported without chapter data. Tap to select the EPUB file.</p>
              </div>
              <input
                id="epub-reupload"
                type="file"
                accept=".epub"
                className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
              />
            </label>
          )}
          {/* Tab bar — always visible */}
          <div className="flex rounded-lg overflow-hidden border border-stone-200 dark:border-zinc-800 mb-5 w-full sm:w-fit flex-shrink-0">
            {([
              { key: 'characters', label: 'Characters' },
              { key: 'locations', label: 'Locations' },
              { key: 'map', label: 'Map' },
              { key: 'arcs', label: 'Arcs' },
              { key: 'manage', label: 'Manage', separated: true },
            ] as { key: MainTab; label: string; separated?: boolean }[]).map(({ key, label, separated }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 sm:flex-none px-4 sm:px-5 py-2.5 sm:py-2 text-sm font-medium transition-colors ${
                  separated ? 'border-l border-stone-200 dark:border-zinc-700' : ''
                } ${
                  tab === key ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100' : 'bg-transparent text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Snapshot navigator — shown on all tabs when snapshots exist */}
          {(stored?.snapshots?.length ?? 0) > 0 && (() => {
            const snaps = [...(stored!.snapshots)].sort((a, b) => a.index - b.index);
            const pos = viewingSnapshotIndex === null
              ? snaps.length - 1  // latest
              : snaps.findIndex((s) => s.index === viewingSnapshotIndex);
            const atLatest = viewingSnapshotIndex === null || pos === snaps.length - 1;
            const snap = snaps[pos];
            const chTitle = normalizeTitle(book.chapters[snap?.index]?.title ?? `Chapter ${(snap?.index ?? 0) + 1}`);
            function goTo(newPos: number) {
              const target = snaps[newPos];
              if (newPos === snaps.length - 1) {
                setCurrentIndex(stored!.lastAnalyzedIndex);
                setResult(stored!.result);
                setViewingSnapshotIndex(null);
              } else {
                setCurrentIndex(target.index);
                setResult(target.result);
                setViewingSnapshotIndex(target.index);
              }
            }
            return (
              <div className="mb-4 flex items-center gap-1 px-2 py-1.5 bg-stone-100/50 dark:bg-zinc-800/50 rounded-xl border border-stone-300/40 dark:border-zinc-700/40 flex-shrink-0">
                <button
                  onClick={() => goTo(Math.max(0, pos - 1))}
                  disabled={pos <= 0 || playing}
                  className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-base text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-zinc-100 hover:bg-stone-200 dark:hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-default transition-colors"
                  title="Previous snapshot"
                >‹</button>
                <span className="flex-1 text-center truncate px-1">
                  {atLatest
                    ? <><span className="text-sm font-semibold text-stone-800 dark:text-zinc-100">ch.{(snap?.index ?? 0) + 1} — {chTitle}</span> <span className="text-xs text-stone-400 dark:text-zinc-500">(latest)</span></>
                    : <><span className="text-xs text-stone-400 dark:text-zinc-500">Viewing </span><span className="text-sm font-semibold text-stone-800 dark:text-zinc-100">ch.{snap.index + 1} — {chTitle}</span> <span className="text-xs text-stone-400 dark:text-zinc-500">({pos + 1}/{snaps.length})</span></>
                  }
                </span>
                <button
                  onClick={() => goTo(Math.min(snaps.length - 1, pos + 1))}
                  disabled={atLatest || playing}
                  className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-base text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-zinc-100 hover:bg-stone-200 dark:hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-default transition-colors"
                  title="Next snapshot"
                >›</button>
                <div className="w-px h-4 bg-stone-300 dark:bg-zinc-700 mx-1" />
                {/* Speed selector */}
                <select
                  value={playSpeed}
                  onChange={(e) => setPlaySpeed(Number(e.target.value))}
                  className="text-xs bg-transparent text-stone-400 dark:text-zinc-500 border-none outline-none cursor-pointer hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
                  title="Playback speed"
                >
                  <option value={3000}>Slow</option>
                  <option value={2000}>Normal</option>
                  <option value={1000}>Fast</option>
                  <option value={400}>Very fast</option>
                </select>
                {/* Play / pause */}
                <button
                  onClick={() => {
                    if (playing) { setPlaying(false); return; }
                    // If at the end, rewind to start first
                    if (atLatest && snaps.length > 1) goTo(0);
                    setPlaying(true);
                  }}
                  className="text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-zinc-100 transition-colors w-6 h-6 flex items-center justify-center rounded-md hover:bg-stone-200 dark:hover:bg-zinc-700"
                  title={playing ? 'Pause' : 'Play through chapters'}
                >
                  {playing
                    ? <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><rect x="0" y="0" width="3" height="12"/><rect x="7" y="0" width="3" height="12"/></svg>
                    : <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><polygon points="0,0 10,6 0,12"/></svg>
                  }
                </button>
              </div>
            );
          })()}

          {/* Map tab — always accessible, fills remaining height */}
          {tab === 'map' && (
            <div className="flex-1 min-h-0 flex flex-col">
              {result?.summary && (
                <div className="mx-0 mb-3 p-4 bg-stone-50 dark:bg-zinc-900 rounded-xl border border-stone-200 dark:border-zinc-800 flex-shrink-0 cursor-pointer hover:border-stone-300 dark:hover:border-zinc-700 transition-colors" onClick={() => setShowTimeline(true)}>
                  <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-2">Story so far</p>
                  <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">{result.summary}</p>
                </div>
              )}
              <div className="flex-1 min-h-0">
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
                  onMapStateChange={(state) => {
                    setMapState(state);
                    saveMapState(book.title, book.author, state);
                  }}
                />
              </div>
            </div>
          )}

          {/* Characters + Locations tabs */}
          {tab !== 'map' && (
            <>

              {!result && !busy && !rebuildProgress && (
                <div className="flex flex-col items-center justify-center flex-1 text-center gap-3">
                  <span className="text-5xl opacity-20">{isSeriesContinuation ? '📚' : '⌖'}</span>
                  <p className="text-stone-500 dark:text-zinc-400 font-medium">
                    {isSeriesContinuation
                      ? 'Series characters loaded. Select a chapter and update.'
                      : 'Select your chapter and analyze.'}
                  </p>
                  <p className="text-sm text-stone-400 dark:text-zinc-600 max-w-xs">
                    {isSeriesContinuation
                      ? 'Only new chapters will be read — your existing characters carry forward.'
                      : "Only what you've read is sent to the model — no spoilers."}
                  </p>
                </div>
              )}

              {(analyzing || rebuilding) && rebuildProgress && (
                <div className={`mb-4 rounded-xl border px-4 py-3 ${rebuilding ? 'border-violet-500/20 bg-violet-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
                  <div className="flex items-center gap-3">
                    <div className={`w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin flex-shrink-0 ${rebuilding ? 'border-violet-500' : 'border-amber-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-stone-700 dark:text-zinc-300 truncate">
                          {rebuilding ? 'Rebuilding' : 'Analyzing'} · {rebuildProgress.current}/{rebuildProgress.total}
                          {rebuildProgress.chapterTitle && (
                            <span className="ml-2 font-normal text-stone-400 dark:text-zinc-500">
                              {rebuildProgress.chapterTitle}
                            </span>
                          )}
                        </p>
                        <button
                          onClick={() => { if (rebuilding) rebuildCancelRef.current = true; else analyzeCancelRef.current = true; }}
                          className="flex-shrink-0 text-xs text-stone-400 dark:text-zinc-600 hover:text-red-400 dark:hover:text-red-500 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      <div className="mt-2 w-full bg-stone-200 dark:bg-zinc-800 rounded-full h-0.5">
                        <div
                          className={`h-0.5 rounded-full transition-all duration-300 ${rebuilding ? 'bg-violet-500' : 'bg-amber-500'}`}
                          style={{ width: `${(rebuildProgress.current / rebuildProgress.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {result && (
                <div>
                  {result.summary && (
                    <div className="mb-5 p-4 bg-stone-50 dark:bg-zinc-900 rounded-xl border border-stone-200 dark:border-zinc-800 cursor-pointer hover:border-stone-300 dark:hover:border-zinc-700 transition-colors" onClick={() => setShowTimeline(true)}>
                      <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-2">Story so far</p>
                      <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">{result.summary}</p>
                    </div>
                  )}

                  {tab === 'characters' && (
                    <>
                      <div className="flex flex-wrap items-center gap-2 mb-4">
                        <input
                          type="search"
                          placeholder="Search…"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-sm text-stone-700 dark:text-zinc-300 placeholder-stone-400 dark:placeholder-zinc-600 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-600 min-w-36 flex-1"
                        />
                        <div className="flex gap-1.5 flex-wrap">
                          {(['all', 'main', 'secondary', 'minor'] as const).map((f) => (
                            <button
                              key={f}
                              onClick={() => setFilter(f)}
                              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                                filter === f
                                  ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100'
                                  : 'text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 border border-stone-200 dark:border-zinc-800 hover:border-stone-300 dark:hover:border-zinc-700'
                              }`}
                            >
                              {f.charAt(0).toUpperCase() + f.slice(1)}
                            </button>
                          ))}
                        </div>
                        <select
                          value={sortKey}
                          onChange={(e) => setSortKey(e.target.value as SortKey)}
                          className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-xs text-stone-400 dark:text-zinc-500 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-600"
                        >
                          <option value="importance">Importance</option>
                          <option value="name">Name</option>
                          <option value="status">Status</option>
                        </select>
                      </div>

                      <div className="flex gap-4 mb-4 text-xs text-stone-400 dark:text-zinc-600">
                        <span>{characters.length} characters</span>
                        <span>·</span>
                        <span>{characters.filter((c) => c.status === 'alive').length} alive</span>
                        <span>·</span>
                        <span>{characters.filter((c) => c.status === 'dead').length} dead</span>
                        <span>·</span>
                        <span>{characters.filter((c) => c.importance === 'main').length} main</span>
                      </div>

                      {displayed.length === 0 ? (
                        <p className="text-center text-stone-400 dark:text-zinc-600 py-12">No characters match.</p>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                          {displayed.map((character) => (
                            <CharacterCard
                              key={character.name}
                              character={character}
                              snapshots={stored?.snapshots ?? []}
                              chapterTitles={book.chapters.map((ch) => ch.title)}
                              currentResult={result}
                              onResultEdit={applyResultEdit}
                              currentChapterIndex={currentChapterIndex}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {tab === 'locations' && (
                    <LocationBoard
                      characters={characters}
                      locations={result.locations}
                      bookTitle={book.title}
                      snapshots={stored?.snapshots ?? []}
                      chapterTitles={book.chapters.map((ch) => ch.title)}
                      currentResult={result}
                      onResultEdit={applyResultEdit}
                      resolvedCharacters={derived.resolvedCharacters}
                      locationAliasMap={derived.locationAliasMap}
                      locationGroups={derived.locationGroups}
                      currentChapterIndex={currentChapterIndex}
                    />
                  )}

                  {tab === 'arcs' && (
                    <ArcsPanel
                      arcs={result.arcs ?? []}
                      snapshots={stored?.snapshots ?? []}
                      chapterTitles={book.chapters.map((ch) => ch.title)}
                      currentResult={result}
                      onResultEdit={applyResultEdit}
                      arcChapterMap={derived.arcChapterMap}
                      currentChapterIndex={currentChapterIndex}
                    />
                  )}

                  {tab === 'manage' && stored && result && (
                    <EntityManager
                      snapshots={stored.snapshots}
                      currentResult={stored.result}
                      chapterTitles={book.chapters.map((ch) => ch.title)}
                      onResultEdit={applyResultEdit}
                      aggregated={derived.aggregated}
                      bookTitle={book.title}
                      bookAuthor={book.author}
                      currentChapterIndex={currentChapterIndex}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
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
    </main>
  );
}
