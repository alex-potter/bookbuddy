/**
 * IndexedDB persistence for book analysis state.
 * Replaces localStorage to avoid silent quota failures that caused data loss
 * when accumulated snapshots exceeded the ~5 MB localStorage limit.
 *
 * A lightweight localStorage index (bookbuddy-index) is maintained for
 * synchronous listing on the "My Books" tab.  Actual state lives in IDB.
 */

import type { MapState, StoredBookState, SavedBookEntry } from '@/types';

const DB_NAME = 'bookbuddy-state';
const DB_VERSION = 1;
const STATE_STORE = 'book-state';
const MAP_STORE = 'map-state';
const INDEX_KEY = 'bookbuddy-index';

function dbKey(title: string, author: string) {
  return `${title}::${author}`;
}

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(MAP_STORE)) db.createObjectStore(MAP_STORE);
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Sync localStorage index  (tiny — just title/author/progress per book)
// ---------------------------------------------------------------------------

function readIndex(): SavedBookEntry[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeIndex(entries: SavedBookEntry[]) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(entries)); } catch { /* index is tiny */ }
}

function updateIndex(title: string, author: string, lastAnalyzedIndex: number, chapterCount?: number) {
  const entries = readIndex();
  const idx = entries.findIndex((e) => e.title === title && e.author === author);
  const entry: SavedBookEntry = { title, author, lastAnalyzedIndex, chapterCount };
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  writeIndex(entries);
}

function removeFromIndex(title: string, author: string) {
  writeIndex(readIndex().filter((e) => !(e.title === title && e.author === author)));
}

/** Synchronous read from the localStorage index — safe to call in render. */
export function listSavedBooks(excludeTitle?: string, excludeAuthor?: string): SavedBookEntry[] {
  return readIndex()
    .filter((e) => !(e.title === excludeTitle && e.author === excludeAuthor))
    .sort((a, b) => b.lastAnalyzedIndex - a.lastAnalyzedIndex);
}

// ---------------------------------------------------------------------------
// Cross-tab sync via BroadcastChannel
// ---------------------------------------------------------------------------

let syncChannel: BroadcastChannel | null = null;
try { syncChannel = new BroadcastChannel('bookbuddy-sync'); } catch { /* SSR / unsupported */ }

// ---------------------------------------------------------------------------
// Book state  (IndexedDB — practically unlimited storage)
// ---------------------------------------------------------------------------

export async function loadBookState(title: string, author: string): Promise<StoredBookState | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, 'readonly');
    const req = tx.objectStore(STATE_STORE).get(dbKey(title, author));
    req.onsuccess = () => {
      const val = req.result as StoredBookState | undefined;
      if (val && !val.snapshots) val.snapshots = []; // back-compat
      resolve(val ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveBookState(title: string, author: string, state: StoredBookState): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, 'readwrite');
    tx.objectStore(STATE_STORE).put(state, dbKey(title, author));
    tx.oncomplete = () => {
      updateIndex(title, author, state.lastAnalyzedIndex, state.bookMeta?.chapters.length);
      syncChannel?.postMessage({ type: 'state', title, author });
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteBookState(title: string, author: string): Promise<void> {
  const db = await openDB();
  const { deleteChapters } = await import('./chapter-storage');
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STATE_STORE, MAP_STORE], 'readwrite');
    tx.objectStore(STATE_STORE).delete(dbKey(title, author));
    tx.objectStore(MAP_STORE).delete(dbKey(title, author));
    tx.oncomplete = () => {
      removeFromIndex(title, author);
      deleteChapters(title, author).catch(() => {});
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Map state  (IndexedDB)
// ---------------------------------------------------------------------------

export async function loadBookMapState(title: string, author: string): Promise<MapState | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MAP_STORE, 'readonly');
    const req = tx.objectStore(MAP_STORE).get(dbKey(title, author));
    req.onsuccess = () => resolve((req.result as MapState) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBookMapState(title: string, author: string, state: MapState): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MAP_STORE, 'readwrite');
    tx.objectStore(MAP_STORE).put(state, dbKey(title, author));
    tx.oncomplete = () => {
      syncChannel?.postMessage({ type: 'map', title, author });
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Migration from localStorage → IndexedDB  (runs once)
// ---------------------------------------------------------------------------

export async function migrateFromLocalStorage(): Promise<void> {
  if (localStorage.getItem('bookbuddy-migrated') === '1') return;

  // Already have an index built from a prior session — nothing to migrate
  const existingIndex = readIndex();

  // Collect keys to migrate
  const stateKeys: Array<{ key: string; title: string; author: string }> = [];
  const mapKeys: Array<{ key: string; title: string; author: string }> = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith('bookbuddy::') || key.startsWith('ebook-tracker::')) {
      const parts = key.split('::');
      if (parts.length >= 3) stateKeys.push({ key, title: parts[1], author: parts.slice(2).join('::') });
    } else if (key.startsWith('bookbuddy-map::')) {
      const rest = key.slice('bookbuddy-map::'.length);
      const sep = rest.indexOf('::');
      if (sep >= 0) mapKeys.push({ key, title: rest.slice(0, sep), author: rest.slice(sep + 2) });
    }
  }

  if (stateKeys.length === 0 && mapKeys.length === 0 && existingIndex.length === 0) {
    localStorage.setItem('bookbuddy-migrated', '1');
    return;
  }

  const db = await openDB();

  // Migrate book state
  for (const { key, title, author } of stateKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = JSON.parse(raw) as StoredBookState;
      if (!state.snapshots) state.snapshots = [];
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STATE_STORE, 'readwrite');
        tx.objectStore(STATE_STORE).put(state, dbKey(title, author));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      updateIndex(title, author, state.lastAnalyzedIndex, state.bookMeta?.chapters.length);
      localStorage.removeItem(key);
    } catch { /* skip corrupted entries */ }
  }

  // Migrate map state
  for (const { key, title, author } of mapKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const mapState = JSON.parse(raw) as MapState;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(MAP_STORE, 'readwrite');
        tx.objectStore(MAP_STORE).put(mapState, dbKey(title, author));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      localStorage.removeItem(key);
    } catch { /* skip corrupted entries */ }
  }

  localStorage.setItem('bookbuddy-migrated', '1');
}

/** Subscribe to cross-tab state changes. Returns a cleanup function. */
export function onCrossTabSync(
  handler: (msg: { type: 'state' | 'map'; title: string; author: string }) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel('bookbuddy-sync');
  ch.onmessage = (e) => handler(e.data);
  return () => ch.close();
}
