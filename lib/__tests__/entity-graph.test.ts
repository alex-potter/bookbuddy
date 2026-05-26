import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// Reset IDB state between tests
beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe('entity-graph store', () => {
  it('is created when book-storage opens at version 2', async () => {
    const { openDB } = await import('@/lib/book-storage');
    const db = await openDB();
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains('entity-graph')).toBe(true);

    // Verify the containerId index exists
    const tx = db.transaction('entity-graph', 'readonly');
    const store = tx.objectStore('entity-graph');
    expect(store.indexNames.contains('containerId')).toBe(true);
  });
});
