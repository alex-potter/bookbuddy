// lib/entity-graph.ts
import type { Character, LocationInfo, NarrativeArc, AnalysisResult, Snapshot } from '@/types';
import { openDB, ENTITY_STORE } from './book-storage';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EntityType = 'character' | 'location' | 'arc';

export interface EntityRecord {
  id: string;                // `${containerId}::${type}::${canonicalLower}`
  containerId: string;       // indexed
  type: EntityType;
  canonicalName: string;
  canonicalLower: string;
  lastSeenOrder: number;
  importance?: 'main' | 'secondary' | 'minor';
  payload: Character | LocationInfo | NarrativeArc;
}

export interface SketchEntry {
  name: string;
  aliases?: string[];
}

export interface RetrievedContext<T> {
  full: T[];
  sketch: SketchEntry[];
  stats: {
    rosterSize: number;
    mentionedCount: number;
    recentCount: number;
    sketchTrimmed: number;
  };
}

export interface MentionedNames {
  characters: Set<string>;
  locations: Set<string>;
  arcs: Set<string>;
}

// ─── Key helpers ────────────────────────────────────────────────────────────

export function keyFor(containerId: string, type: EntityType, canonicalName: string): string {
  return `${containerId}::${type}::${canonicalName.toLowerCase().trim()}`;
}

export function containerKey(title: string, author: string): string {
  return `${title}::${author}`;
}

// Re-export for consumers that need the store name
export { openDB, ENTITY_STORE };

// ─── Transaction helper ─────────────────────────────────────────────────────

async function tx(mode: IDBTransactionMode): Promise<{
  store: IDBObjectStore;
  done: Promise<void>;
}> {
  const db = await openDB();
  const transaction = db.transaction(ENTITY_STORE, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return { store: transaction.objectStore(ENTITY_STORE), done };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function upsertEntity(
  containerId: string,
  type: EntityType,
  payload: Character | LocationInfo | NarrativeArc,
  lastSeenOrder: number,
): Promise<void> {
  const { store, done } = await tx('readwrite');
  const id = keyFor(containerId, type, payload.name);
  const record: EntityRecord = {
    id,
    containerId,
    type,
    canonicalName: payload.name,
    canonicalLower: payload.name.toLowerCase().trim(),
    lastSeenOrder,
    importance: (payload as Character).importance,
    payload,
  };
  store.put(record, id);
  await done;
}

export async function getAllByContainer(
  containerId: string,
  type?: EntityType,
): Promise<EntityRecord[]> {
  const { store, done } = await tx('readonly');
  const index = store.index('containerId');
  const req = index.getAll(IDBKeyRange.only(containerId));
  const records = await new Promise<EntityRecord[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as EntityRecord[]);
    req.onerror = () => reject(req.error);
  });
  await done;
  return type ? records.filter(r => r.type === type) : records;
}

export async function deleteEntity(id: string): Promise<void> {
  const { store, done } = await tx('readwrite');
  store.delete(id);
  await done;
}

export async function deleteByContainer(containerId: string): Promise<void> {
  const records = await getAllByContainer(containerId);
  const { store, done } = await tx('readwrite');
  for (const r of records) store.delete(r.id);
  await done;
}

// ─── syncFromResult helpers ─────────────────────────────────────────────────

function aliasesOfPayload(p: Character | LocationInfo | NarrativeArc): string[] {
  const cast = p as Partial<Character & LocationInfo>;
  return cast.aliases ?? [];
}

/**
 * Find a record in newResult that has `record.canonicalName` in its aliases —
 * indicates it absorbed this record (rename or merge).
 */
function findAbsorberByAlias(
  record: EntityRecord,
  newResult: AnalysisResult,
): { type: EntityType; name: string } | null {
  const absorbedLower = record.canonicalName.toLowerCase().trim();
  const pool: Array<{ type: EntityType; items: Array<Character | LocationInfo | NarrativeArc> }> = [
    { type: 'character', items: newResult.characters },
    { type: 'location', items: newResult.locations ?? [] },
    { type: 'arc', items: newResult.arcs ?? [] },
  ];

  for (const { type, items } of pool) {
    if (type !== record.type) continue;
    for (const it of items) {
      if (aliasesOfPayload(it).some(a => a.toLowerCase().trim() === absorbedLower)) {
        return { type, name: it.name };
      }
    }
  }
  return null;
}

// ─── syncFromResult ─────────────────────────────────────────────────────────

interface SyncMentions {
  characters: Set<string>;   // lowercased names
  locations: Set<string>;
  arcs: Set<string>;
}

export async function syncFromResult(
  containerId: string,
  newResult: AnalysisResult,
  mentioned: SyncMentions,
  chapterOrder: number,
): Promise<void> {
  const existing = await getAllByContainer(containerId);
  const existingByKey = new Map(existing.map(r => [keyFor(containerId, r.type, r.canonicalName), r]));

  const validKeys = new Set<string>();

  // Helper to upsert with lastSeenOrder rules
  async function syncOne(
    type: EntityType,
    payload: Character | LocationInfo | NarrativeArc,
    mentionedSet: Set<string>,
  ) {
    const key = keyFor(containerId, type, payload.name);
    validKeys.add(key);
    const prev = existingByKey.get(key);
    const wasMentioned = mentionedSet.has(payload.name.toLowerCase().trim());
    const lastSeen = wasMentioned ? chapterOrder : (prev?.lastSeenOrder ?? chapterOrder);
    await upsertEntity(containerId, type, payload, lastSeen);
  }

  for (const c of newResult.characters) await syncOne('character', c, mentioned.characters);
  for (const l of newResult.locations ?? []) await syncOne('location', l, mentioned.locations);
  for (const a of newResult.arcs ?? []) await syncOne('arc', a, mentioned.arcs);

  // Delete records no longer present in newResult; fold lastSeenOrder into
  // any absorber whose aliases include the deleted record's canonical name.
  for (const r of existing) {
    const key = keyFor(containerId, r.type, r.canonicalName);
    if (validKeys.has(key)) continue;

    const absorber = findAbsorberByAlias(r, newResult);
    if (absorber) {
      const absorberKey = keyFor(containerId, absorber.type, absorber.name);
      const absorberRecord = (await getAllByContainer(containerId, absorber.type))
        .find(rec => keyFor(containerId, rec.type, rec.canonicalName) === absorberKey);
      if (absorberRecord && r.lastSeenOrder > absorberRecord.lastSeenOrder) {
        // Re-upsert absorber with the folded lastSeenOrder (max of the two)
        await upsertEntity(containerId, absorber.type, absorberRecord.payload, r.lastSeenOrder);
      }
    }
    await deleteEntity(r.id);
  }
}

// ─── Rebuild from snapshots ─────────────────────────────────────────────────

export async function rebuildEntityGraph(
  containerId: string,
  snapshots: Snapshot[],
): Promise<void> {
  await deleteByContainer(containerId);

  // Walk in chapter-index order so later snapshots overwrite earlier.
  const ordered = [...snapshots].sort((a, b) => a.index - b.index);
  for (const snap of ordered) {
    const order = snap.index;
    for (const c of snap.result.characters) {
      await upsertEntity(containerId, 'character', c, order);
    }
    for (const l of snap.result.locations ?? []) {
      await upsertEntity(containerId, 'location', l, order);
    }
    for (const a of snap.result.arcs ?? []) {
      await upsertEntity(containerId, 'arc', a, order);
    }
  }
}
