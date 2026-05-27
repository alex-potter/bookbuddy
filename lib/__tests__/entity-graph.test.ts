import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { Character } from '@/types';

// Reset IDB state and module cache between tests so dbInstance is cleared
beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
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

function ch(name: string, aliases: string[] = []): Character {
  return {
    name,
    aliases,
    importance: 'secondary',
    status: 'alive',
    lastSeen: 'Ch. 1',
    currentLocation: 'Unknown',
    description: '',
    relationships: [],
    recentEvents: '',
  };
}

describe('entity-graph CRUD', () => {
  it('upsert + getAllByContainer round-trip', async () => {
    const { upsertEntity, getAllByContainer } = await import('@/lib/entity-graph');
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book1', 'character', ch('Mat'), 0);
    await upsertEntity('book2', 'character', ch('Frodo'), 0);

    const book1 = await getAllByContainer('book1');
    expect(book1.map(r => r.canonicalName).sort()).toEqual(['Mat', 'Rand']);

    const book2 = await getAllByContainer('book2');
    expect(book2.map(r => r.canonicalName)).toEqual(['Frodo']);
  });

  it('getAllByContainer filters by type when provided', async () => {
    const { upsertEntity, getAllByContainer } = await import('@/lib/entity-graph');
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book1', 'location', { name: "Emond's Field", description: '' }, 0);

    const chars = await getAllByContainer('book1', 'character');
    expect(chars).toHaveLength(1);
    expect(chars[0].type).toBe('character');
  });

  it('upsert overwrites an existing record with the same key', async () => {
    const { upsertEntity, getAllByContainer } = await import('@/lib/entity-graph');
    await upsertEntity('book1', 'character', ch('Rand', []), 0);
    await upsertEntity('book1', 'character', ch('Rand', ['Dragon Reborn']), 5);

    const all = await getAllByContainer('book1');
    expect(all).toHaveLength(1);
    expect(all[0].lastSeenOrder).toBe(5);
    expect((all[0].payload as Character).aliases).toEqual(['Dragon Reborn']);
  });

  it('deleteEntity removes a single record by id', async () => {
    const { upsertEntity, getAllByContainer, deleteEntity, keyFor } = await import('@/lib/entity-graph');
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book1', 'character', ch('Mat'), 0);

    await deleteEntity(keyFor('book1', 'character', 'Rand'));

    const all = await getAllByContainer('book1');
    expect(all.map(r => r.canonicalName)).toEqual(['Mat']);
  });

  it('deleteByContainer wipes only that container', async () => {
    const { upsertEntity, getAllByContainer, deleteByContainer } = await import('@/lib/entity-graph');
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book2', 'character', ch('Frodo'), 0);

    await deleteByContainer('book1');

    expect(await getAllByContainer('book1')).toHaveLength(0);
    expect(await getAllByContainer('book2')).toHaveLength(1);
  });
});
