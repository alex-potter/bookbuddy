import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { Character } from '@/types';
import type { AnalysisResult } from '@/types';

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

function result(chars: Character[]): AnalysisResult {
  return { characters: chars, summary: '' };
}

describe('syncFromResult', () => {
  it('inserts new entities and sets lastSeenOrder when mentioned', async () => {
    const { syncFromResult, getAllByContainer } = await import('@/lib/entity-graph');
    const newRes = result([ch('Rand'), ch('Mat')]);
    await syncFromResult('c', newRes, {
      characters: new Set(['rand']),
      locations: new Set(),
      arcs: new Set(),
    }, 5);

    const all = await getAllByContainer('c');
    expect(all.find(r => r.canonicalName === 'Rand')!.lastSeenOrder).toBe(5);
    expect(all.find(r => r.canonicalName === 'Mat')!.lastSeenOrder).toBe(5);  // no prior — defaults to chapter
  });

  it('preserves lastSeenOrder for not-mentioned existing entities', async () => {
    const { syncFromResult, getAllByContainer, upsertEntity } = await import('@/lib/entity-graph');
    await upsertEntity('c', 'character', ch('Rand'), 3);
    await upsertEntity('c', 'character', ch('Mat'), 7);

    const newRes = result([ch('Rand'), ch('Mat')]);
    await syncFromResult('c', newRes, {
      characters: new Set(['rand']),       // only Rand mentioned this chapter
      locations: new Set(), arcs: new Set(),
    }, 10);

    const all = await getAllByContainer('c');
    expect(all.find(r => r.canonicalName === 'Rand')!.lastSeenOrder).toBe(10);  // updated
    expect(all.find(r => r.canonicalName === 'Mat')!.lastSeenOrder).toBe(7);    // preserved
  });

  it('deletes records absent from newResult (rename case)', async () => {
    const { syncFromResult, getAllByContainer, upsertEntity } = await import('@/lib/entity-graph');
    // Pre-existing: Mat with last-seen=5
    await upsertEntity('c', 'character', ch('Mat'), 5);

    // newResult renames Mat → "Matrim Cauthon" with "Mat" as alias
    const newRes = result([ch('Matrim Cauthon', ['Mat'])]);
    await syncFromResult('c', newRes, {
      characters: new Set(['matrim cauthon']), locations: new Set(), arcs: new Set(),
    }, 10);

    const all = await getAllByContainer('c');
    expect(all).toHaveLength(1);
    expect(all[0].canonicalName).toBe('Matrim Cauthon');
    // lastSeenOrder folded from absorbed Mat (5) AND mentioned this chapter (10) → take max = 10
    expect(all[0].lastSeenOrder).toBe(10);
  });

  it('folds absorbed lastSeenOrder when absorber was NOT mentioned this chapter', async () => {
    const { syncFromResult, getAllByContainer, upsertEntity } = await import('@/lib/entity-graph');
    // Mat existed with last-seen=8; newResult merges Mat into Matrim, but
    // chapter doesn't actually mention Matrim Cauthon.
    await upsertEntity('c', 'character', ch('Mat'), 8);

    const newRes = result([ch('Matrim Cauthon', ['Mat'])]);
    await syncFromResult('c', newRes, {
      characters: new Set(),    // nothing mentioned this chapter
      locations: new Set(), arcs: new Set(),
    }, 10);

    const all = await getAllByContainer('c');
    expect(all).toHaveLength(1);
    // No prior Matrim record, not mentioned this chapter → defaults to chapterOrder=10,
    // then folded with absorbed Mat=8 → max(10, 8) = 10
    expect(all[0].lastSeenOrder).toBe(10);
  });

  it('split case (one record → two): old name disappears, both new appear', async () => {
    const { syncFromResult, getAllByContainer, upsertEntity } = await import('@/lib/entity-graph');
    await upsertEntity('c', 'character', ch('Caemlyn'), 5);   // confused entry

    // newResult splits into "Caemlyn the City" and "Caemlyn of Andor"
    const newRes = result([ch('Caemlyn the City'), ch('Caemlyn of Andor')]);
    await syncFromResult('c', newRes, {
      characters: new Set(['caemlyn the city', 'caemlyn of andor']),
      locations: new Set(), arcs: new Set(),
    }, 10);

    const all = await getAllByContainer('c');
    expect(all.map(r => r.canonicalName).sort()).toEqual(['Caemlyn of Andor', 'Caemlyn the City']);
  });
});
