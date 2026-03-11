/**
 * IndexedDB persistence for chapter text.
 * Allows restoring a book's chapters without re-uploading the EPUB.
 */

const DB_NAME = 'bookbuddy-chapters';
const DB_VERSION = 1;
const STORE = 'chapters';

function dbKey(title: string, author: string) {
  return `${title}::${author}`;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface ChapterTextEntry {
  id: string;
  text: string;
}

export async function saveChapters(
  title: string,
  author: string,
  chapters: ChapterTextEntry[],
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(chapters, dbKey(title, author));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadChapters(
  title: string,
  author: string,
): Promise<ChapterTextEntry[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(dbKey(title, author));
    req.onsuccess = () => resolve((req.result as ChapterTextEntry[]) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteChapters(title: string, author: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(dbKey(title, author));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
