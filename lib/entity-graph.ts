// lib/entity-graph.ts
import type { Character, LocationInfo, NarrativeArc } from '@/types';
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
