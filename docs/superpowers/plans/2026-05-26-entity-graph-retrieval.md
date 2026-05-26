# Entity-graph retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "embed the entire entity roster in every prompt" pattern with a container-scoped, queryable entity graph that delivers only mentioned + recently-active entities as full detail plus a budget-trimmed sketch list of everyone else — eliminating series-scale prompt bloat that currently forces chunking.

**Architecture:** Materialized entity graph stored per container in IndexedDB (v2 of `bookbuddy-state` DB). `syncFromResult` writes the graph incrementally after every analyze pass; `rebuildEntityGraph` is the universal recovery primitive for rollback, edit propagation, container changes, and migration. Read path (`retrieveContext`) is a pure function: word-boundary regex against names+aliases ∪ recency-window filter, then budget-shaped tiered output.

**Tech Stack:** Existing project (Next.js 14 / TypeScript / IndexedDB). New dev dependencies: `vitest` + `@vitest/coverage-v8` + `fake-indexeddb` for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-26-entity-graph-retrieval-design.md`

---

## File map

**Created**
- `lib/entity-graph.ts` — types, DB helpers, CRUD, `syncFromResult`, `rebuildEntityGraph`
- `lib/retrieve-context.ts` — `STOPWORDS`, `RECENCY_WINDOW`, `buildAliasRegex`, `matchAliasesInText`, `trimSketch`, `estimateCharSize`, `estimateSketchEntrySize`, `retrieveContext`, format helpers
- `vitest.config.ts`
- `vitest.setup.ts`
- `lib/__tests__/smoke.test.ts`
- `lib/__tests__/build-alias-regex.test.ts`
- `lib/__tests__/retrieve-context.test.ts` (covers `trimSketch`, `matchAliasesInText`, `retrieveContext`)
- `lib/__tests__/entity-graph.test.ts` (covers CRUD, `syncFromResult`, `rebuildEntityGraph`)

**Modified**
- `package.json` — devDeps + `test` script
- `.gitignore` — coverage output
- `lib/book-storage.ts` — bump `DB_VERSION`, create `entity-graph` store
- `lib/ai-shared.ts` — new format helpers that accept `RetrievedContext`
- `app/api/analyze/route.ts` — wire `retrieveContext` into prompt building + `syncFromResult` after each chunk
- `lib/ai-client.ts` — same wiring for client path
- `lib/propagate-edit.ts` — trigger `rebuildEntityGraph` after propagation
- `app/page.tsx` — trigger `rebuildEntityGraph` after rollback and container edits

---

## Task 0: Create a feature branch

**Files:** working tree

- [ ] **Step 1: Confirm clean baseline and branch**

```bash
git status --short
```
Expected: only the pre-existing `M app/api/analyze/route.ts` and `?? .vscode/` (untracked). The spec file from brainstorming should already be committed.

```bash
git checkout -b feat/entity-graph-retrieval
```
Expected: `Switched to a new branch 'feat/entity-graph-retrieval'`

---

## Task 1: Set up vitest + fake-indexeddb

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `lib/__tests__/smoke.test.ts`

- [ ] **Step 1: Install dev dependencies**

```bash
npm install --save-dev vitest @vitest/coverage-v8 fake-indexeddb
```
Expected: `package.json` updated; lockfile updated; no warnings about peer deps.

- [ ] **Step 2: Add the `test` script to package.json**

In `package.json`, add to the `scripts` block (preserve ordering of existing scripts):
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Add coverage output to .gitignore**

Append to `.gitignore`:
```
/coverage/
```

- [ ] **Step 4: Create vitest.config.ts**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['lib/**/*.test.ts', 'lib/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
```

- [ ] **Step 5: Create vitest.setup.ts**

```ts
// vitest.setup.ts
// fake-indexeddb provides a Node-compatible IndexedDB implementation.
// /auto installs it on globalThis (indexedDB, IDBKeyRange, etc.).
import 'fake-indexeddb/auto';
```

- [ ] **Step 6: Write the smoke test**

```ts
// lib/__tests__/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('vitest smoke test', () => {
  it('runs arithmetic', () => {
    expect(1 + 1).toBe(2);
  });

  it('has the indexedDB polyfill installed', async () => {
    expect(typeof indexedDB).toBe('object');

    const req = indexedDB.open('smoke-test', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('test');
      };
    });
    expect(db.objectStoreNames.contains('test')).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 7: Run the smoke test**

```bash
npm test
```
Expected: 2 tests pass; no warnings about missing setup; takes <2 seconds.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore vitest.config.ts vitest.setup.ts lib/__tests__/smoke.test.ts
git commit -m "test: add vitest with fake-indexeddb for IDB unit tests"
```

---

## Task 2: EntityRecord types + IDB v2 migration

**Files:**
- Create: `lib/entity-graph.ts`
- Modify: `lib/book-storage.ts`
- Test: `lib/__tests__/entity-graph.test.ts`

- [ ] **Step 1: Write the failing test for the v2 store**

```ts
// lib/__tests__/entity-graph.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- entity-graph
```
Expected: FAIL because either `openDB` is not exported (likely) or DB_VERSION is still 1.

- [ ] **Step 3: Export `openDB` from book-storage.ts**

In `lib/book-storage.ts`, change `function openDB()` (around line 24) to `export function openDB()`. Leave everything else in that function unchanged.

- [ ] **Step 4: Bump DB_VERSION and add the entity-graph store**

In `lib/book-storage.ts`, change:
```ts
const DB_VERSION = 1;
```
to:
```ts
const DB_VERSION = 2;
const ENTITY_STORE = 'entity-graph';
```

And inside `openDB()`'s `onupgradeneeded` handler, append (alongside the existing `STATE_STORE` and `MAP_STORE` creation):
```ts
if (!db.objectStoreNames.contains(ENTITY_STORE)) {
  const store = db.createObjectStore(ENTITY_STORE);
  store.createIndex('containerId', 'containerId', { unique: false });
}
```

Export the constant so other modules use the same name:
```ts
export { ENTITY_STORE };
```

- [ ] **Step 5: Create lib/entity-graph.ts skeleton with types**

```ts
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
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npm test -- entity-graph
```
Expected: PASS — smoke + the new "is created at version 2" test.

- [ ] **Step 7: Commit**

```bash
git add lib/book-storage.ts lib/entity-graph.ts lib/__tests__/entity-graph.test.ts
git commit -m "feat(entity-graph): add IDB v2 store and base types"
```

---

## Task 3: entity-graph CRUD primitives

**Files:**
- Modify: `lib/entity-graph.ts`
- Modify: `lib/__tests__/entity-graph.test.ts`

- [ ] **Step 1: Write failing tests for getAllByContainer / upsertEntity / deleteEntity / deleteByContainer**

Append to `lib/__tests__/entity-graph.test.ts`:

```ts
import {
  upsertEntity,
  getAllByContainer,
  deleteEntity,
  deleteByContainer,
  keyFor,
} from '@/lib/entity-graph';
import type { Character } from '@/types';

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
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book1', 'character', ch('Mat'), 0);
    await upsertEntity('book2', 'character', ch('Frodo'), 0);

    const book1 = await getAllByContainer('book1');
    expect(book1.map(r => r.canonicalName).sort()).toEqual(['Mat', 'Rand']);

    const book2 = await getAllByContainer('book2');
    expect(book2.map(r => r.canonicalName)).toEqual(['Frodo']);
  });

  it('getAllByContainer filters by type when provided', async () => {
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book1', 'location', { name: 'Emond\'s Field', description: '' }, 0);

    const chars = await getAllByContainer('book1', 'character');
    expect(chars).toHaveLength(1);
    expect(chars[0].type).toBe('character');
  });

  it('upsert overwrites an existing record with the same key', async () => {
    await upsertEntity('book1', 'character', ch('Rand', []), 0);
    await upsertEntity('book1', 'character', ch('Rand', ['Dragon Reborn']), 5);

    const all = await getAllByContainer('book1');
    expect(all).toHaveLength(1);
    expect(all[0].lastSeenOrder).toBe(5);
    expect((all[0].payload as Character).aliases).toEqual(['Dragon Reborn']);
  });

  it('deleteEntity removes a single record by id', async () => {
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book1', 'character', ch('Mat'), 0);

    await deleteEntity(keyFor('book1', 'character', 'Rand'));

    const all = await getAllByContainer('book1');
    expect(all.map(r => r.canonicalName)).toEqual(['Mat']);
  });

  it('deleteByContainer wipes only that container', async () => {
    await upsertEntity('book1', 'character', ch('Rand'), 0);
    await upsertEntity('book2', 'character', ch('Frodo'), 0);

    await deleteByContainer('book1');

    expect(await getAllByContainer('book1')).toHaveLength(0);
    expect(await getAllByContainer('book2')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- entity-graph
```
Expected: FAIL — the named exports don't exist yet.

- [ ] **Step 3: Implement CRUD primitives in lib/entity-graph.ts**

Append to `lib/entity-graph.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- entity-graph
```
Expected: all CRUD tests PASS (~5–6 new passing tests).

- [ ] **Step 5: Commit**

```bash
git add lib/entity-graph.ts lib/__tests__/entity-graph.test.ts
git commit -m "feat(entity-graph): CRUD primitives (upsert/getAll/delete)"
```

---

## Task 4: buildAliasRegex + STOPWORDS

**Files:**
- Create: `lib/retrieve-context.ts`
- Create: `lib/__tests__/build-alias-regex.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/build-alias-regex.test.ts
import { describe, it, expect } from 'vitest';
import { buildAliasRegex, STOPWORDS } from '@/lib/retrieve-context';
import type { EntityRecord } from '@/lib/entity-graph';
import type { Character } from '@/types';

function rec(name: string, aliases: string[] = []): EntityRecord {
  return {
    id: `c::character::${name.toLowerCase()}`,
    containerId: 'c',
    type: 'character',
    canonicalName: name,
    canonicalLower: name.toLowerCase(),
    lastSeenOrder: 0,
    payload: {
      name,
      aliases,
      importance: 'secondary',
      status: 'alive',
      lastSeen: '',
      currentLocation: '',
      description: '',
      relationships: [],
      recentEvents: '',
    } as Character,
  };
}

describe('buildAliasRegex', () => {
  it('returns null for empty input', () => {
    expect(buildAliasRegex([])).toBeNull();
  });

  it('matches exact names case-insensitively at word boundaries', () => {
    const re = buildAliasRegex([rec('Rand')])!;
    expect('rand walked away'.match(re)).not.toBeNull();
    expect('Rand walked away'.match(re)).not.toBeNull();
    expect('Brandon walked away'.match(re)).toBeNull();  // word boundary
  });

  it('matches aliases', () => {
    const re = buildAliasRegex([rec('Matrim Cauthon', ['Mat'])])!;
    expect('Mat grinned'.match(re)).not.toBeNull();
    expect('Matrim grinned'.match(re)).toBeNull();   // 'Matrim' alone isn\'t an alias
    expect('Matrim Cauthon grinned'.match(re)).not.toBeNull();
  });

  it('sorts longest-first so multi-word names win over their prefixes', () => {
    const re = buildAliasRegex([rec('Matrim Cauthon', ['Mat'])])!;
    const m = re.exec('Matrim Cauthon was here');
    expect(m![1]).toBe('Matrim Cauthon');     // not 'Mat'
  });

  it('filters aliases shorter than 3 chars', () => {
    const re = buildAliasRegex([rec('Al')])!;
    expect(re).toBeNull();  // Al is length 2 → filtered → no aliases left → null
  });

  it('filters stopwords (titles that collide with common English)', () => {
    expect(STOPWORDS.has('lord')).toBe(true);
    expect(STOPWORDS.has('father')).toBe(true);
    const re = buildAliasRegex([rec('Father', ['Lord'])])!;
    expect(re).toBeNull();
  });

  it('escapes regex metacharacters in names', () => {
    const re = buildAliasRegex([rec('M.O.D.O.K.')])!;
    expect('M.O.D.O.K. attacks'.match(re)).not.toBeNull();
    expect('MaOaDaOaKa attacks'.match(re)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- build-alias-regex
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement buildAliasRegex in lib/retrieve-context.ts**

```ts
// lib/retrieve-context.ts
import type { Character, LocationInfo, NarrativeArc } from '@/types';
import type { EntityRecord, EntityType, SketchEntry, RetrievedContext } from './entity-graph';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Lowercase tokens we never want to treat as character/location aliases.
 * These tend to appear in chapter text constantly and would cause floods
 * of false-positive mentions.
 */
export const STOPWORDS = new Set<string>([
  'the', 'lord', 'lady', 'king', 'queen', 'sir',
  'father', 'mother', 'brother', 'sister', 'son', 'daughter',
  'captain', 'master', 'mistress', 'man', 'woman', 'boy', 'girl',
  'one', 'two', 'three',
]);

const MAX_ALIASES_PER_PATTERN = 5000;
const MAX_PATTERN_BYTES = 1_000_000;

// ─── Regex building ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasesOf(rec: EntityRecord): string[] {
  // Arcs have no `aliases` field; LocationInfo's is optional.
  const payload = rec.payload as Partial<Character & LocationInfo>;
  return payload.aliases ?? [];
}

/**
 * Compile a single word-boundary alternation matching every canonical name +
 * alias in the input records. Returns null if no usable aliases survive
 * stopword/length filtering.
 *
 * Sorts longest-first so multi-word names match before their prefixes.
 */
export function buildAliasRegex(records: EntityRecord[]): RegExp | null {
  const aliasMap = new Map<string, EntityRecord>();
  for (const r of records) {
    for (const alias of [r.canonicalName, ...aliasesOf(r)]) {
      const lower = alias.toLowerCase().trim();
      if (lower.length < 3) continue;
      if (STOPWORDS.has(lower)) continue;
      if (!aliasMap.has(lower)) aliasMap.set(lower, r);
    }
  }

  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  if (aliases.length === 0) return null;
  if (aliases.length > MAX_ALIASES_PER_PATTERN) aliases.length = MAX_ALIASES_PER_PATTERN;

  let source = `\\b(${aliases.map(escapeRegex).join('|')})\\b`;
  if (source.length > MAX_PATTERN_BYTES) {
    // Trim further to fit byte cap; preserves longest aliases (highest signal).
    while (source.length > MAX_PATTERN_BYTES && aliases.length > 0) {
      aliases.pop();
      source = `\\b(${aliases.map(escapeRegex).join('|')})\\b`;
    }
    if (aliases.length === 0) return null;
  }

  try {
    return new RegExp(source, 'giu');
  } catch (err) {
    console.warn('[entity-graph] regex compile failed, halving alias set', err);
    aliases.length = Math.floor(aliases.length / 2);
    if (aliases.length === 0) return null;
    return new RegExp(`\\b(${aliases.map(escapeRegex).join('|')})\\b`, 'giu');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- build-alias-regex
```
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/retrieve-context.ts lib/__tests__/build-alias-regex.test.ts
git commit -m "feat(retrieve-context): alias regex with stopwords + longest-first"
```

---

## Task 5: matchAliasesInText

**Files:**
- Modify: `lib/retrieve-context.ts`
- Create: `lib/__tests__/retrieve-context.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/retrieve-context.test.ts
import { describe, it, expect } from 'vitest';
import { matchAliasesInText, buildAliasRegex } from '@/lib/retrieve-context';
import type { EntityRecord } from '@/lib/entity-graph';
import type { Character } from '@/types';

function rec(name: string, aliases: string[] = [], id?: string): EntityRecord {
  return {
    id: id ?? `c::character::${name.toLowerCase()}`,
    containerId: 'c',
    type: 'character',
    canonicalName: name,
    canonicalLower: name.toLowerCase(),
    lastSeenOrder: 0,
    payload: {
      name, aliases,
      importance: 'secondary', status: 'alive',
      lastSeen: '', currentLocation: '', description: '',
      relationships: [], recentEvents: '',
    } as Character,
  };
}

describe('matchAliasesInText', () => {
  it('returns IDs of records whose names appear in the text', () => {
    const records = [rec('Rand'), rec('Mat'), rec('Egwene')];
    const ids = matchAliasesInText(records, 'Rand and Egwene walked through the village');
    expect(ids.sort()).toEqual(['c::character::egwene', 'c::character::rand']);
  });

  it('returns empty array when nothing matches', () => {
    const records = [rec('Rand'), rec('Mat')];
    const ids = matchAliasesInText(records, 'A different story entirely.');
    expect(ids).toEqual([]);
  });

  it('deduplicates: one mention per record even if mentioned multiple times', () => {
    const records = [rec('Rand')];
    const ids = matchAliasesInText(records, 'Rand looked at Rand and thought of Rand.');
    expect(ids).toEqual(['c::character::rand']);
  });

  it('resolves aliases back to the canonical record id', () => {
    const records = [rec('Matrim Cauthon', ['Mat'])];
    const ids = matchAliasesInText(records, 'Mat grinned.');
    expect(ids).toEqual([records[0].id]);
  });

  it('returns empty array when buildAliasRegex returns null', () => {
    // No usable aliases (all stopwords)
    const records = [rec('Father'), rec('Lord')];
    expect(buildAliasRegex(records)).toBeNull();
    expect(matchAliasesInText(records, 'Father Lord passed by')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- retrieve-context
```
Expected: FAIL — `matchAliasesInText` not exported.

- [ ] **Step 3: Implement matchAliasesInText**

Append to `lib/retrieve-context.ts`:

```ts
// ─── Mention detection ──────────────────────────────────────────────────────

/**
 * Scan chapter text for any alias of any record. Returns a deduplicated list
 * of record IDs whose name or alias appears in the text.
 */
export function matchAliasesInText(records: EntityRecord[], text: string): string[] {
  // Rebuild the alias→record map (mirror of what buildAliasRegex did internally).
  const aliasMap = new Map<string, EntityRecord>();
  for (const r of records) {
    for (const alias of [r.canonicalName, ...aliasesOf(r)]) {
      const lower = alias.toLowerCase().trim();
      if (lower.length < 3) continue;
      if (STOPWORDS.has(lower)) continue;
      if (!aliasMap.has(lower)) aliasMap.set(lower, r);
    }
  }

  const pattern = buildAliasRegex(records);
  if (!pattern) return [];

  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const matched = m[1].toLowerCase();
    const rec = aliasMap.get(matched);
    if (rec) hits.add(rec.id);
  }
  return [...hits];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- retrieve-context
```
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/retrieve-context.ts lib/__tests__/retrieve-context.test.ts
git commit -m "feat(retrieve-context): matchAliasesInText resolves to record IDs"
```

---

## Task 6: trimSketch + size estimators + RECENCY_WINDOW

**Files:**
- Modify: `lib/retrieve-context.ts`
- Modify: `lib/__tests__/retrieve-context.test.ts`

- [ ] **Step 1: Write failing tests for trimSketch + estimators**

Append to `lib/__tests__/retrieve-context.test.ts`:

```ts
import { trimSketch, estimateSketchEntrySize, estimateCharSize, RECENCY_WINDOW } from '@/lib/retrieve-context';

function recImp(name: string, importance: 'main' | 'secondary' | 'minor', lastSeen: number, aliases: string[] = []): EntityRecord {
  return {
    ...rec(name, aliases),
    lastSeenOrder: lastSeen,
    importance,
  };
}

describe('trimSketch', () => {
  it('returns empty when budget is 0', () => {
    const out = trimSketch([recImp('A', 'main', 0)], 0);
    expect(out).toEqual([]);
  });

  it('returns all entries when budget exceeds total size', () => {
    const out = trimSketch([recImp('Rand', 'main', 0), recImp('Mat', 'main', 0)], 1_000_000);
    expect(out.map(e => e.name).sort()).toEqual(['Mat', 'Rand']);
  });

  it('keeps highest-importance first when trimming', () => {
    const records = [
      recImp('Minor1', 'minor', 0),
      recImp('Main1', 'main', 0),
      recImp('Secondary1', 'secondary', 0),
    ];
    // Budget enough for ~2 entries
    const oneCost = estimateSketchEntrySize({ name: 'Main1' });
    const out = trimSketch(records, oneCost * 2 + 5);
    expect(out.map(e => e.name)).toContain('Main1');
    expect(out.map(e => e.name)).toContain('Secondary1');
    expect(out.map(e => e.name)).not.toContain('Minor1');
  });

  it('breaks importance ties by recency DESC', () => {
    const records = [
      recImp('Old', 'main', 0),
      recImp('Recent', 'main', 100),
    ];
    const oneCost = estimateSketchEntrySize({ name: 'Recent' });
    const out = trimSketch(records, oneCost + 2);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Recent');
  });

  it('includes aliases in the sketch entry when present', () => {
    const out = trimSketch([recImp('Matrim Cauthon', 'main', 0, ['Mat'])], 1_000_000);
    expect(out[0].aliases).toEqual(['Mat']);
  });

  it('omits aliases field when the record has none', () => {
    const out = trimSketch([recImp('Rand', 'main', 0)], 1_000_000);
    expect(out[0].aliases).toBeUndefined();
  });
});

describe('RECENCY_WINDOW', () => {
  it('uses different windows per entity type', () => {
    expect(RECENCY_WINDOW.character).toBeGreaterThan(0);
    expect(RECENCY_WINDOW.location).toBeGreaterThan(RECENCY_WINDOW.character);
    expect(RECENCY_WINDOW.arc).toBe(Infinity);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- retrieve-context
```
Expected: FAIL on the new describe blocks.

- [ ] **Step 3: Implement trimSketch + estimators + RECENCY_WINDOW**

Append to `lib/retrieve-context.ts`:

```ts
// ─── Sketch trimming + size estimators ──────────────────────────────────────

export const RECENCY_WINDOW: Record<EntityType, number> = {
  character: 5,
  location: 8,
  arc: Infinity,   // arcs are capped at ~8 already; always include
};

const IMPORTANCE_RANK: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

export function estimateSketchEntrySize(e: SketchEntry): number {
  // Format the LLM sees: "- Name [aliases: a, b]\n"
  const aliasPart = e.aliases?.length ? ` [aliases: ${e.aliases.join(', ')}]` : '';
  return 3 + e.name.length + aliasPart.length;   // "- " + name + aliases + "\n"
}

export function estimateCharSize<T>(items: T[]): number {
  // Conservative: serialize as JSON and measure. The actual prompt format is
  // shorter, but this is the right order of magnitude and is provider-agnostic.
  return JSON.stringify(items).length;
}

/**
 * Reduce a candidate list to fit within charBudget, preferring higher
 * importance and more-recently-seen entries.
 */
export function trimSketch(others: EntityRecord[], charBudget: number): SketchEntry[] {
  if (charBudget <= 0) return [];

  const sorted = [...others].sort((a, b) => {
    const ai = IMPORTANCE_RANK[a.importance ?? 'secondary'] ?? 2;
    const bi = IMPORTANCE_RANK[b.importance ?? 'secondary'] ?? 2;
    if (ai !== bi) return bi - ai;
    return b.lastSeenOrder - a.lastSeenOrder;
  });

  const kept: SketchEntry[] = [];
  let used = 0;
  for (const r of sorted) {
    const aliases = aliasesOf(r);
    const entry: SketchEntry = aliases.length
      ? { name: r.canonicalName, aliases }
      : { name: r.canonicalName };
    const cost = estimateSketchEntrySize(entry);
    if (used + cost > charBudget) break;
    kept.push(entry);
    used += cost;
  }
  return kept;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- retrieve-context
```
Expected: trimSketch + RECENCY_WINDOW tests PASS (existing matchAliasesInText tests still PASS).

- [ ] **Step 5: Commit**

```bash
git add lib/retrieve-context.ts lib/__tests__/retrieve-context.test.ts
git commit -m "feat(retrieve-context): trimSketch + recency windows + size estimators"
```

---

## Task 7: retrieveContext orchestration

**Files:**
- Modify: `lib/retrieve-context.ts`
- Modify: `lib/__tests__/retrieve-context.test.ts`

- [ ] **Step 1: Write failing tests for retrieveContext**

Append to `lib/__tests__/retrieve-context.test.ts`:

```ts
import { retrieveContext } from '@/lib/retrieve-context';
import { upsertEntity } from '@/lib/entity-graph';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';

describe('retrieveContext', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('returns empty result for an empty container', async () => {
    const ctx = await retrieveContext('empty', 'character', 'some text', 10, 1000);
    expect(ctx.full).toEqual([]);
    expect(ctx.sketch).toEqual([]);
    expect(ctx.stats.rosterSize).toBe(0);
  });

  it('puts mentioned entities in full tier, others in sketch', async () => {
    await upsertEntity('c', 'character', { name: 'Rand', aliases: [], importance: 'main', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 0);
    await upsertEntity('c', 'character', { name: 'Mat', aliases: [], importance: 'main', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 0);
    await upsertEntity('c', 'character', { name: 'Perrin', aliases: [], importance: 'main', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 0);

    // Only Rand mentioned, none in recency window (lastSeenOrder=0, chapterOrder=20, N=5)
    const ctx = await retrieveContext('c', 'character', 'Rand walked alone.', 20, 1000);

    expect(ctx.full.map((c: any) => c.name)).toEqual(['Rand']);
    expect(ctx.sketch.map(s => s.name).sort()).toEqual(['Mat', 'Perrin']);
    expect(ctx.stats.mentionedCount).toBe(1);
    expect(ctx.stats.recentCount).toBe(0);
  });

  it('includes entities seen within the recency window even when not mentioned', async () => {
    await upsertEntity('c', 'character', { name: 'Rand', aliases: [], importance: 'main', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 18);
    await upsertEntity('c', 'character', { name: 'Egwene', aliases: [], importance: 'main', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 10);  // outside window

    // chapterOrder=20, N=5 → recency boundary is order ≥ 15. Rand (18) included, Egwene (10) not.
    const ctx = await retrieveContext('c', 'character', 'unrelated text', 20, 1000);

    expect(ctx.full.map((c: any) => c.name)).toEqual(['Rand']);
    expect(ctx.sketch.map(s => s.name)).toEqual(['Egwene']);
    expect(ctx.stats.mentionedCount).toBe(0);
    expect(ctx.stats.recentCount).toBe(1);
  });

  it('mentioned ∪ recent — overlap counted only once', async () => {
    await upsertEntity('c', 'character', { name: 'Rand', aliases: [], importance: 'main', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 18);

    const ctx = await retrieveContext('c', 'character', 'Rand returned.', 20, 1000);
    expect(ctx.full).toHaveLength(1);
    expect(ctx.stats.mentionedCount).toBe(1);
    expect(ctx.stats.recentCount).toBe(0);   // recent excludes the mentioned overlap
  });

  it('reports sketchTrimmed when budget is too small for everyone', async () => {
    for (let i = 0; i < 10; i++) {
      await upsertEntity('c', 'character', { name: `Char${i}`, aliases: [], importance: 'minor', status: 'alive', lastSeen: '', currentLocation: '', description: '', relationships: [], recentEvents: '' }, 0);
    }
    // Budget only enough for ~2 sketch entries
    const ctx = await retrieveContext('c', 'character', 'unrelated', 100, 25);
    expect(ctx.sketch.length).toBeLessThan(10);
    expect(ctx.stats.sketchTrimmed).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- retrieve-context
```
Expected: FAIL — `retrieveContext` not exported.

- [ ] **Step 3: Implement retrieveContext**

Append to `lib/retrieve-context.ts`:

```ts
// ─── Top-level retrieval ────────────────────────────────────────────────────

import { getAllByContainer } from './entity-graph';

/**
 * Per-chapter retrieval: returns the entities to send to the LLM, split into
 * a `full` tier (full payloads — mentioned in chapter text OR in recency window)
 * and a `sketch` tier (name + aliases only, budget-trimmed).
 */
export async function retrieveContext<T = unknown>(
  containerId: string,
  type: EntityType,
  chapterText: string,
  chapterOrder: number,
  charBudget: number,
): Promise<RetrievedContext<T>> {
  const records = await getAllByContainer(containerId, type);
  if (records.length === 0) {
    return {
      full: [],
      sketch: [],
      stats: { rosterSize: 0, mentionedCount: 0, recentCount: 0, sketchTrimmed: 0 },
    };
  }

  const mentionedIds = new Set(matchAliasesInText(records, chapterText));

  const window = RECENCY_WINDOW[type];
  const recentIds = new Set<string>();
  for (const r of records) {
    if (r.lastSeenOrder >= chapterOrder - window) recentIds.add(r.id);
  }

  const fullIds = new Set([...mentionedIds, ...recentIds]);
  const full: T[] = [];
  const others: EntityRecord[] = [];
  for (const r of records) {
    if (fullIds.has(r.id)) full.push(r.payload as T);
    else others.push(r);
  }

  const fullSize = estimateCharSize(full);
  const sketch = trimSketch(others, Math.max(0, charBudget - fullSize));

  // "recent" stat = recent AND NOT mentioned (the new info recency adds)
  let recentOnly = 0;
  for (const id of recentIds) if (!mentionedIds.has(id)) recentOnly++;

  return {
    full,
    sketch,
    stats: {
      rosterSize: records.length,
      mentionedCount: mentionedIds.size,
      recentCount: recentOnly,
      sketchTrimmed: others.length - sketch.length,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- retrieve-context
```
Expected: all retrieveContext tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/retrieve-context.ts lib/__tests__/retrieve-context.test.ts
git commit -m "feat(retrieve-context): retrieveContext orchestration (mentioned + recency + budget)"
```

---

## Task 8: syncFromResult

**Files:**
- Modify: `lib/entity-graph.ts`
- Modify: `lib/__tests__/entity-graph.test.ts`

- [ ] **Step 1: Write failing tests for syncFromResult**

Append to `lib/__tests__/entity-graph.test.ts`:

```ts
import { syncFromResult } from '@/lib/entity-graph';
import type { AnalysisResult } from '@/types';

const emptyMentions = { characters: new Set<string>(), locations: new Set<string>(), arcs: new Set<string>() };

function result(chars: Character[]): AnalysisResult {
  return { characters: chars, summary: '' };
}

describe('syncFromResult', () => {
  it('inserts new entities and sets lastSeenOrder when mentioned', async () => {
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
    await upsertEntity('c', 'character', ch('Caemlyn'), 5);   // confused entry

    // newResult splits into "Caemlyn (the city)" and "Caemlyn (the character)"
    const newRes = result([ch('Caemlyn the City'), ch('Caemlyn of Andor')]);
    await syncFromResult('c', newRes, {
      characters: new Set(['caemlyn the city', 'caemlyn of andor']),
      locations: new Set(), arcs: new Set(),
    }, 10);

    const all = await getAllByContainer('c');
    expect(all.map(r => r.canonicalName).sort()).toEqual(['Caemlyn of Andor', 'Caemlyn the City']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- entity-graph
```
Expected: FAIL — `syncFromResult` not exported.

- [ ] **Step 3: Implement syncFromResult and its helpers**

Append to `lib/entity-graph.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- entity-graph
```
Expected: all 5 syncFromResult tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/entity-graph.ts lib/__tests__/entity-graph.test.ts
git commit -m "feat(entity-graph): syncFromResult with alias-absorption lastSeen folding"
```

---

## Task 9: rebuildEntityGraph

**Files:**
- Modify: `lib/entity-graph.ts`
- Modify: `lib/__tests__/entity-graph.test.ts`

- [ ] **Step 1: Write failing tests for rebuildEntityGraph**

Append to `lib/__tests__/entity-graph.test.ts`:

```ts
import { rebuildEntityGraph } from '@/lib/entity-graph';
import type { Snapshot } from '@/types';

function snap(index: number, chars: Character[]): Snapshot {
  return { index, result: { characters: chars, summary: '' } };
}

describe('rebuildEntityGraph', () => {
  it('wipes the container when snapshots is empty', async () => {
    await upsertEntity('c', 'character', ch('Rand'), 0);
    await rebuildEntityGraph('c', []);
    expect(await getAllByContainer('c')).toEqual([]);
  });

  it('builds the graph from a single snapshot', async () => {
    await rebuildEntityGraph('c', [snap(3, [ch('Rand'), ch('Mat')])]);
    const all = await getAllByContainer('c');
    expect(all.map(r => r.canonicalName).sort()).toEqual(['Mat', 'Rand']);
    expect(all.every(r => r.lastSeenOrder === 3)).toBe(true);
  });

  it('later snapshots overwrite earlier ones — final lastSeenOrder is the max', async () => {
    await rebuildEntityGraph('c', [
      snap(0, [ch('Rand')]),
      snap(5, [ch('Rand'), ch('Mat')]),
      snap(10, [ch('Rand'), ch('Mat'), ch('Perrin')]),
    ]);
    const all = await getAllByContainer('c');
    const byName = new Map(all.map(r => [r.canonicalName, r]));
    expect(byName.get('Rand')!.lastSeenOrder).toBe(10);
    expect(byName.get('Mat')!.lastSeenOrder).toBe(10);
    expect(byName.get('Perrin')!.lastSeenOrder).toBe(10);
  });

  it('clears prior records for this container only', async () => {
    await upsertEntity('keep', 'character', ch('OtherBook'), 0);
    await rebuildEntityGraph('c', [snap(0, [ch('Rand')])]);
    expect((await getAllByContainer('keep')).map(r => r.canonicalName)).toEqual(['OtherBook']);
    expect((await getAllByContainer('c')).map(r => r.canonicalName)).toEqual(['Rand']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- entity-graph
```
Expected: FAIL — `rebuildEntityGraph` not exported.

- [ ] **Step 3: Implement rebuildEntityGraph**

Append to `lib/entity-graph.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- entity-graph
```
Expected: all 4 rebuildEntityGraph tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/entity-graph.ts lib/__tests__/entity-graph.test.ts
git commit -m "feat(entity-graph): rebuildEntityGraph from snapshots"
```

---

## Task 10: Format helpers + ai-shared.ts integration

**Files:**
- Modify: `lib/ai-shared.ts`
- Modify: `lib/retrieve-context.ts`

- [ ] **Step 1: Add format helpers to retrieve-context.ts**

Append to `lib/retrieve-context.ts`:

```ts
// ─── Prompt format helpers ──────────────────────────────────────────────────

/**
 * Format a RetrievedContext for inclusion in a prompt. Returns two blocks:
 *   - "fullBlock":   detailed entries the LLM should treat as known context
 *   - "sketchBlock": one-line entries the LLM should be aware exist (avoid
 *                    creating duplicates), without their detailed state
 */
export function formatCharContext(ctx: RetrievedContext<Character>): {
  fullBlock: string;
  sketchBlock: string;
} {
  const fullBlock = ctx.full
    .map(c => {
      const aliasStr = c.aliases?.length ? ` [aliases: ${c.aliases.join(', ')}]` : '';
      return `- ${c.name}${aliasStr} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`;
    })
    .join('\n');

  const sketchBlock = ctx.sketch
    .map(s => {
      const aliasStr = s.aliases?.length ? ` [aliases: ${s.aliases.join(', ')}]` : '';
      return `- ${s.name}${aliasStr}`;
    })
    .join('\n');

  return { fullBlock, sketchBlock };
}

export function formatLocContext(ctx: RetrievedContext<LocationInfo>): {
  fullBlock: string;
  sketchBlock: string;
} {
  const fullBlock = ctx.full
    .map(l => `- ${l.name}: ${l.description ?? '(no description yet)'}`)
    .join('\n');

  const sketchBlock = ctx.sketch
    .map(s => `- ${s.name}`)
    .join('\n');

  return { fullBlock, sketchBlock };
}

export function formatArcContext(ctx: RetrievedContext<NarrativeArc>): {
  fullBlock: string;
  sketchBlock: string;
} {
  const fullBlock = ctx.full
    .map(a => `- ${a.name} [${a.status}]: ${a.summary}`)
    .join('\n');

  const sketchBlock = ctx.sketch
    .map(s => `- ${s.name}`)
    .join('\n');

  return { fullBlock, sketchBlock };
}
```

- [ ] **Step 2: Add a sketch-aware delta prompt builder to ai-shared.ts**

In `lib/ai-shared.ts`, add a new exported function alongside the existing `buildUpdatePrompt`:

```ts
/**
 * Tiered-context variant of buildUpdatePrompt. Replaces the unbounded
 * EXISTING CHARACTERS list with two tiers: detailed (mentioned + recent)
 * and sketch (name-only roster, so the LLM doesn't dup against existing
 * entries it can't see in full).
 */
export function buildUpdatePromptTiered(
  bookTitle: string,
  bookAuthor: string,
  currentChapterTitle: string,
  fullCharsBlock: string,
  sketchCharsBlock: string,
  arcList: string,
  newChaptersText: string,
): string {
  const knownSection = fullCharsBlock
    ? `KNOWN CHARACTERS (full detail — these have appeared recently or are mentioned in this chapter):\n${fullCharsBlock}\n`
    : '';
  const rosterSection = sketchCharsBlock
    ? `\nALSO TRACKED (names only — to avoid duplicates; do NOT reproduce in your output):\n${sketchCharsBlock}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

${knownSection}${rosterSection}${arcList ? `\nEXISTING NARRATIVE ARCS (carry forward unchanged arcs; only include in "updatedArcs" if this chapter changes them):\n${arcList}\n` : ''}
NEW CHAPTER TEXT TO PROCESS:
${newChaptersText}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
1. Read the new chapter text carefully.
2. For each character who APPEARS in the new chapter: include them in "updatedCharacters" with updated fields.
3. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in.
4. Do NOT include characters from KNOWN CHARACTERS or ALSO TRACKED who do not appear in the new chapter.
5. When returning an existing character, use their EXACT NAME from KNOWN CHARACTERS or ALSO TRACKED. Do NOT use a shortened form.
6. ONLY include characters whose name or alias literally appears in the new chapter text. Do NOT hallucinate characters.
7. For any location appearing in this chapter: include it in "updatedLocations".
8. For narrative arcs: include in "updatedArcs" only those that progressed, changed status, or are new this chapter.
9. Update the summary to reflect the story as of the current chapter.
10. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.

Return ONLY a JSON object with "updatedCharacters", "updatedLocations", and "summary" (no markdown fences, no explanation):
${DELTA_SCHEMA}`;
}
```

- [ ] **Step 3: Run tests to confirm nothing regressed**

```bash
npm test
```
Expected: all existing tests still PASS. No new test for this task — these are pure string builders that will be exercised by the integration step (Task 11) and the manual test plan.

- [ ] **Step 4: Commit**

```bash
git add lib/retrieve-context.ts lib/ai-shared.ts
git commit -m "feat(ai-shared): tiered-context prompt builders + format helpers"
```

---

## Task 11: Wire into app/api/analyze/route.ts

**Files:**
- Modify: `app/api/analyze/route.ts`

- [ ] **Step 1: Read the current route's POST handler to find the integration points**

```bash
npm run -s test 2>/dev/null || true   # ensure tests still pass
```

Open `app/api/analyze/route.ts` and locate:
- The `body` type definition in `POST` (around line 1830). Add `_containerId?: string` and `_chapterOrder?: number`.
- `runMultiPassDelta` (around line 1681). This is where prompt-building happens for delta passes.
- The chunk loop in POST (around line 1893 for delta path, 1934 for full path) — `syncFromResult` is called inside this loop after `runMultiPassDelta` returns.

- [ ] **Step 2: Extend the request body type and parsing**

In `app/api/analyze/route.ts`, in the `POST` handler, extend the body type:

```ts
const body = await req.json() as {
  // ... existing fields ...
  _containerId?: string;
  _chapterOrder?: number;
};
```

After existing destructuring, extract:

```ts
const containerId = body._containerId ?? `${body.bookTitle}::${body.bookAuthor}`;
const chapterOrder = body._chapterOrder ?? 0;
```

- [ ] **Step 3: Add retrieval imports**

At the top of `app/api/analyze/route.ts`, alongside the other imports:

```ts
import { retrieveContext, formatCharContext, formatLocContext, formatArcContext } from '@/lib/retrieve-context';
import { syncFromResult, type MentionedNames } from '@/lib/entity-graph';
```

- [ ] **Step 4: Replace the character-context block in buildCharactersDeltaPrompt callers**

In `runMultiPassDelta` (around line 1696), before the `runPassWithSplitting` call for characters, retrieve the tiered context:

```ts
// Compute char budget: 40% of available context for entity context (per spec).
const conservativeOverhead = 6000;
const outputReserve = config.provider === 'ollama' ? 4096 : 8192;
const availableTokens = (contextWindow ?? 8192) - outputReserve - Math.ceil(conservativeOverhead / 3.5);
const entityCharBudget = Math.floor((availableTokens * 3.5) * 0.4);

const charCtx = await retrieveContext<Character>(
  containerId, 'character', text, chapterOrder, entityCharBudget,
);
console.log(`[retrieve] container=${containerId} type=character chapter=${chapterOrder} ` +
  `rosterSize=${charCtx.stats.rosterSize} mentioned=${charCtx.stats.mentionedCount} ` +
  `recent=${charCtx.stats.recentCount} full=${charCtx.full.length} sketch=${charCtx.sketch.length} trimmed=${charCtx.stats.sketchTrimmed}`);
```

Then update the `buildCharactersDeltaPrompt` call site to use the retrieved subset instead of `previousResult.characters`:

```ts
const { result: charsResult, rateLimitWaitMs: rlChars } = await runPassWithSplitting<CharDeltaResult>(
  charSystem,
  (t) => buildCharactersDeltaPrompt(
    bookTitle, bookAuthor, chapterTitle,
    [...charCtx.full],   // pass only the full tier as the "EXISTING CHARACTERS" block
    t, charDeltaSchema,
  ),
  config, 'characters-delta', text, contextWindow, config.provider === 'ollama' ? 4096 : undefined,
);
```

Add a follow-up that appends the sketch block by passing it via a new optional 7th argument. Modify `buildCharactersDeltaPrompt` in `app/api/analyze/route.ts` (around line 410) to accept an optional `sketchBlock: string` parameter and inject it after the EXISTING CHARACTERS section:

```ts
function buildCharactersDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  previousCharacters: AnalysisResult['characters'],
  text: string,
  schema = CHARACTER_DELTA_SCHEMA,
  sketchBlock = '',
): string {
  const prevCount = previousCharacters.length;
  const charLines = previousCharacters.map(/* unchanged */).join('\n');
  const sketchSection = sketchBlock
    ? `\nALSO TRACKED (names only — to avoid duplicates; do NOT reproduce in your output):\n${sketchBlock}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

EXISTING CHARACTERS (${prevCount} already tracked — DO NOT reproduce this list in your output):
${charLines}
${sketchSection}
NEW CHAPTER TEXT:
${text}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
${/* rest unchanged */}`;
}
```

And pass the sketch block at the call site:

```ts
const { fullBlock, sketchBlock } = formatCharContext(charCtx);
// ...
(t) => buildCharactersDeltaPrompt(
  bookTitle, bookAuthor, chapterTitle,
  charCtx.full, t, charDeltaSchema, sketchBlock,
),
```

- [ ] **Step 5: Repeat for locations and arcs prompt builders**

For `buildLocationsDeltaPrompt`, add an optional `sketchBlock` parameter and inject after the EXISTING LOCATIONS block. Retrieve the location context similarly:

```ts
const locCtx = await retrieveContext<LocationInfo>(
  containerId, 'location', text, chapterOrder, entityCharBudget,
);
```

And update `charactersSummary` calls inside location/arc prompt builders to use `charCtx.full` (already in scope from earlier) instead of the full `currentCharacters` list. This is the change that actually trims the downstream prompts.

For arcs, retrieve once and pass `arcCtx.full` (which will usually equal all arcs, since `RECENCY_WINDOW.arc === Infinity`):

```ts
const arcCtx = await retrieveContext<NarrativeArc>(
  containerId, 'arc', text, chapterOrder, entityCharBudget,
);
```

- [ ] **Step 6: Compute mentionedNames from chunkDelta and call syncFromResult**

In the POST handler's chunk loop (around line 1897 for delta path), after `runMultiPassDelta` returns:

```ts
const mentioned: MentionedNames = {
  characters: new Set(chunkDelta.characters.map(c => c.name.toLowerCase().trim())),
  locations: new Set(chunkDelta.locations.map(l => l.name.toLowerCase().trim())),
  arcs: new Set(chunkDelta.arcs.map(a => a.name.toLowerCase().trim())),
};
await syncFromResult(containerId, chunkResult, mentioned, chapterOrder);
```

Do the same in the full-path chunk loop (around line 1955) after each `runMultiPassDelta` call. For the very first chunk of a full analysis (`runMultiPassFull`), compute mentioned from the returned `firstResult`:

```ts
const mentionedFirst: MentionedNames = {
  characters: new Set(firstResult.characters.map(c => c.name.toLowerCase().trim())),
  locations: new Set((firstResult.locations ?? []).map(l => l.name.toLowerCase().trim())),
  arcs: new Set((firstResult.arcs ?? []).map(a => a.name.toLowerCase().trim())),
};
await syncFromResult(containerId, firstResult, mentionedFirst, chapterOrder);
```

- [ ] **Step 7: Pass chapterOrder through runMultiPassDelta / runMultiPassFull**

Add `chapterOrder: number, containerId: string` parameters to both `runMultiPassFull` and `runMultiPassDelta` signatures, plumb them from POST through to the prompt-building step. (No semantic change to those functions other than threading the values.)

- [ ] **Step 8: Build the project to catch type errors**

```bash
npm run build
```
Expected: build succeeds. If you see "Property '_containerId' does not exist" etc., re-check Step 2.

- [ ] **Step 9: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat(analyze): wire retrieveContext + syncFromResult into delta + full paths"
```

---

## Task 12: Wire into lib/ai-client.ts (client/mobile path)

**Files:**
- Modify: `lib/ai-client.ts`

- [ ] **Step 1: Find the parallel call sites in ai-client.ts**

The client path mirrors `app/api/analyze/route.ts` for the static-export / Capacitor build. Open `lib/ai-client.ts` and locate the equivalent `runMultiPassDelta` / `runMultiPassFull` / POST-equivalent functions (search for `buildCharactersDeltaPrompt`, `mergeDelta`, `chunkDelta`).

- [ ] **Step 2: Apply the same edits as Task 11 (steps 3–7)**

Add the same imports, `retrieveContext` calls, sketch-block plumbing, and `syncFromResult` calls in the client path. The container ID derivation is the same (`${bookTitle}::${bookAuthor}`); the caller has access to `chapterOrder` via the same surface (the analyze invocation in `app/page.tsx`).

- [ ] **Step 3: Add the same containerId + chapterOrder params to the client entrypoint**

If `lib/ai-client.ts` exports an `analyze(...)` function, add `containerId: string, chapterOrder: number` parameters. Update the caller in `app/page.tsx` to pass them — the container's storage key (`${title}::${author}`) is `containerId`; `chapterOrder` is the chapter being analyzed (`currentIndex` or equivalent).

- [ ] **Step 4: Build to verify types**

```bash
npm run build
```
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add lib/ai-client.ts app/page.tsx
git commit -m "feat(ai-client): wire retrieveContext + syncFromResult into client path"
```

---

## Task 13: Trigger rebuildEntityGraph from edit propagation + rollback + container edits

**Files:**
- Modify: `lib/propagate-edit.ts`
- Modify: `app/page.tsx`

- [ ] **Step 1: Find where SnapshotTransforms are applied to snapshots**

```bash
```
Open `lib/propagate-edit.ts`. The `SnapshotTransform` functions (`renameCharacter`, `mergeCharacters`, etc.) are applied by another caller — search the codebase:

```bash
```
Use Grep to find: `renameCharacter|mergeCharacters|propagate` across `app/`, `components/`, `lib/`. Identify the function that maps a transform across `state.snapshots`.

- [ ] **Step 2: Trigger rebuildEntityGraph after that mapping completes**

In each call site that applies a `SnapshotTransform` to `state.snapshots` and writes back to storage, add a call after `saveBookState` returns:

```ts
import { rebuildEntityGraph } from '@/lib/entity-graph';
// ...
await saveBookState(title, author, updatedState);
await rebuildEntityGraph(`${title}::${author}`, updatedState.snapshots);
```

- [ ] **Step 3: Trigger rebuildEntityGraph after rollback**

In `app/page.tsx`, find the rollback handler (search for "rollback" or "rollbackToChapter"). After the snapshot list is trimmed and persisted:

```ts
await rebuildEntityGraph(`${title}::${author}`, trimmedSnapshots);
```

- [ ] **Step 4: Trigger rebuildEntityGraph after container edits**

In `app/page.tsx`, find handlers that mutate `container` (e.g., `handleSaveContainer`, `handleSetRange`, chapter exclusion). After the new state is persisted, rebuild:

```ts
await rebuildEntityGraph(`${title}::${author}`, currentSnapshots);
```

- [ ] **Step 5: Build to verify types**

```bash
npm run build
```
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/propagate-edit.ts app/page.tsx
git commit -m "feat(entity-graph): rebuild on propagateEdit / rollback / container edits"
```

---

## Task 14: Lazy migration backfill + fallback when graph is missing

**Files:**
- Modify: `lib/retrieve-context.ts`
- Modify: `lib/entity-graph.ts`

- [ ] **Step 1: Add a graph-presence check + lazy backfill in retrieveContext**

In `lib/retrieve-context.ts`, modify the start of `retrieveContext`:

```ts
import { getAllByContainer, rebuildEntityGraph } from './entity-graph';
import { loadBookState } from './book-storage';

export async function retrieveContext<T = unknown>(
  containerId: string,
  type: EntityType,
  chapterText: string,
  chapterOrder: number,
  charBudget: number,
): Promise<RetrievedContext<T>> {
  let records = await getAllByContainer(containerId, type);

  // Lazy migration: if the graph is empty but the book has snapshots,
  // backfill from snapshots once. Subsequent calls hit the populated graph.
  if (records.length === 0) {
    const [title, author] = containerId.split('::');
    const state = await loadBookState(title, author);
    if (state?.snapshots?.length) {
      console.log(`[entity-graph] lazy backfill for container=${containerId} (${state.snapshots.length} snapshots)`);
      await rebuildEntityGraph(containerId, state.snapshots);
      records = await getAllByContainer(containerId, type);
    }
  }

  if (records.length === 0) {
    return {
      full: [],
      sketch: [],
      stats: { rosterSize: 0, mentionedCount: 0, recentCount: 0, sketchTrimmed: 0 },
    };
  }
  // ... rest unchanged
}
```

- [ ] **Step 2: Add a debug feature flag**

In `lib/retrieve-context.ts`, at the top of `retrieveContext`:

```ts
// Debug feature flag: bypass the graph entirely to compare behavior.
const disabled = typeof localStorage !== 'undefined' && localStorage.getItem('bookbuddy-disable-entity-graph') === '1';
if (disabled) {
  return {
    full: [],
    sketch: [],
    stats: { rosterSize: 0, mentionedCount: 0, recentCount: 0, sketchTrimmed: 0 },
  };
}
```

Callers in `app/api/analyze/route.ts` and `lib/ai-client.ts` already fall back to the existing `currentCharacters`/`previousResult` lists when `full` is empty, so disabling here is sufficient.

- [ ] **Step 3: Build to verify types**

```bash
npm run build
```
Expected: succeeds. Note: `localStorage` is browser-only; the server route runs in Node, so the `typeof localStorage !== 'undefined'` guard is correct (returns false on server).

- [ ] **Step 4: Commit**

```bash
git add lib/retrieve-context.ts
git commit -m "feat(retrieve-context): lazy backfill + debug-disable flag"
```

---

## Task 15: Manual test plan walkthrough

**Files:** none modified

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```
Expected: all PASS.

- [ ] **Step 2: Run a full build**

```bash
npm run build
```
Expected: succeeds with no errors.

- [ ] **Step 3: Start the dev server**

```bash
npm run dev
```
Server starts at http://localhost:3000.

- [ ] **Step 4: Execute the spec's manual test plan**

Walk through these scenarios (from `docs/superpowers/specs/2026-05-26-entity-graph-retrieval-design.md` § Testing strategy):

1. **Small book**: upload a small EPUB (10–20 chapters). After analyzing the first ~3 chapters, open DevTools → Application → IndexedDB → `bookbuddy-state` → `entity-graph`. Verify records exist with `containerId`, `canonicalName`, `lastSeenOrder`, `payload`.

2. **Rollback**: with the small book analyzed through chapter 5, use the UI to roll back to chapter 2. Re-check `entity-graph` — records introduced in chapters 3–5 should be gone or have `lastSeenOrder ≤ 2`.

3. **Rename**: rename a character via the UI. Verify the canonical name updates in `entity-graph` and the old name appears in the kept record's aliases.

4. **Series append**: process book 1 of a small series, then upload book 2 and choose "Add to existing series" in `SeriesPicker`. Verify the existing `entity-graph` extends — book 1's records still present, book 2's records added with `lastSeenOrder` in book 2's chapter-order range.

5. **WoT-scale**: process the WoT omnibus (or any series with >3 books available) through book 3. Watch the dev server console for `[retrieve] ... full=N sketch=M trimmed=K` lines. Verify NO `[analyze] Chapter ... split into N chunks` log lines (this was the original symptom).

6. **Disable flag**: in DevTools console, run `localStorage.setItem('bookbuddy-disable-entity-graph', '1')`. Re-analyze a chapter. Verify the prompt size returns to pre-change levels (look for the chunking warning to reappear on long chapters). Then `localStorage.removeItem('bookbuddy-disable-entity-graph')`.

7. **Synthetic high-mention chapter (optional)**: create a small test EPUB with a chapter that mentions 250+ distinct names. Verify `splitChapterText` engages as the safety net (look for `[analyze] Chapter ... split into N chunks` log).

- [ ] **Step 5: Document results in a checklist comment on the eventual PR**

Either inline in the commit body or as a note for the PR description, capture which scenarios were verified and any deltas observed (e.g., "WoT book 3 ch. 12: before=3 chunks, after=1 chunk; prompt size 47k→8k chars").

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/entity-graph-retrieval
```
Expected: branch pushed; CI runs `npm run build` + `npm test`.

---

## Self-review check

Before declaring the plan complete, the planner ran these checks:

**Spec coverage:**
- ✅ Local-first design — no tool-calling, deterministic regex, fake-IDB tests prove Ollama/llama.cpp paths
- ✅ Tiered full + sketch — `formatCharContext` etc. produce both blocks
- ✅ Regex + recency — `buildAliasRegex` + `RECENCY_WINDOW` + `retrieveContext`
- ✅ All three entity types — every store/format/retrieve function accepts `EntityType`
- ✅ Series-aware via container — `containerId` is the key everywhere
- ✅ Materialized graph in IDB — `lib/entity-graph.ts` with v2 migration
- ✅ syncFromResult on every analyze chunk — Task 11/12 wires it in
- ✅ rebuildEntityGraph on rollback/edit/container changes — Task 13
- ✅ Vitest unit tests added — Tasks 1, 3, 4, 5, 6, 7, 8, 9
- ✅ Manual test plan — Task 15

**Placeholder scan:** no TBD/TODO/"fill in details" in code blocks. Step 1 of Task 13 has a Grep instruction (find call sites) — that's a discovery step, not a placeholder, and is justified because the existing propagate-edit applier may be co-located with several edit-handler call sites that aren't fully visible from the spec alone.

**Type consistency:** `EntityRecord`, `RetrievedContext<T>`, `MentionedNames`, `SketchEntry` referenced consistently across tasks. `keyFor(containerId, type, name)` signature matches across CRUD, sync, and tests. `RECENCY_WINDOW` keys (`character`/`location`/`arc`) match `EntityType` union.
