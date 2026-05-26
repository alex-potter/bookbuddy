# Entity-graph retrieval for series-aware context trimming

**Status:** Design approved, ready for implementation plan
**Date:** 2026-05-26
**Owner:** Alex Potter

## Context

As a reader progresses through a long series (Wheel of Time, ~2,700 named characters across 14 books being the canonical worst case), the cumulative roster of tracked entities grows unbounded. Each per-chapter analyze call currently embeds the entire roster (via `compactCharacterList`) into every prompt — characters, locations, and arcs each include the full character summary for cross-reference.

At ~80 chars/entry × thousands of entries, the entity blocks alone consume 50k+ tokens before the chapter text is even added. This forces `splitChapterText` to chunk the chapter into multiple LLM calls, each of which re-sends the full roster. The chunking degrades analysis quality (cross-chunk references are lost) and multiplies cost.

The fix is to stop sending the whole roster every chapter. Instead, derive a per-chapter relevant subset via deterministic pre-retrieval, and ship the rest as a lightweight "you know these names exist" sketch list so the LLM can still avoid creating duplicates.

## Goals

1. Eliminate roster-driven chunking for series-scale entity sets across **all supported providers**, prioritizing local Ollama / Android llama.cpp (8–16k context) as the binding constraint.
2. Preserve dedup correctness — the LLM must not create duplicate characters because canonical names were trimmed from the prompt.
3. Maintain rollback / propagateEdit / container-edit semantics — every operation that mutates state today must continue to produce consistent results.
4. Make the retrieval layer **future-extensible** for chat-time queries against the entity graph and (potentially) cross-series queries.

## Non-goals

- Chat-time "tell me about character X" queries (graph supports it, UI is out of scope for this spec).
- Cross-series / cross-container retrieval. Scope stays within a single container.
- Semantic / embedding-based retrieval. Out of scope for v1; can layer in later if needed.
- Restructuring snapshots so they are derived from the graph. Snapshots remain the source of truth.
- New UI for linking separate-EPUB books into a series. `SeriesPicker` + `handleAppendToSeries` already cover this.

## User decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Scope of providers to support well | **Local first** — design must work for 8–16k context Ollama and Android llama.cpp; cloud benefits as a side effect. |
| Retrieval set per chapter | **Tiered: full + sketch** — full detail for the relevant subset; one-line name+aliases sketch for everyone else, so the LLM avoids duplicates. |
| Mention detection algorithm | **Regex + recency** — word-boundary regex against canonical names/aliases, plus auto-include any entity seen in the last N chapters. Deterministic, no extra LLM call. |
| Which entity types | **All three** — characters, locations, and arcs all flow through the retrieval layer. Arcs benefit little (capped at 8) but consistency wins. |
| Cross-book scope | **Series-aware** — retrieval pool spans all books in the same container. Container linking is already wired up via `SeriesPicker.handleAppendToSeries`. |
| Implementation approach | **Materialized entity graph in IDB** (Approach B) — new IDB store, indexed access, updated incrementally; snapshots remain authoritative; rebuild from snapshots is the universal recovery path. |
| Testing | **Add vitest** as a dev dependency for unit-testing the pure helpers, alongside a manual test plan. |

## Architecture

### Storage layout

Existing `bookbuddy-state` IDB database, bumped from version 1 → version 2. One new object store added:

```
bookbuddy-state DB (v2)
├── book-state       snapshots, lastAnalyzedIndex, container         [source of truth]
├── map-state        entity positions on the map
└── entity-graph     per-container entity records                     [NEW, derived]
                     key: `${containerId}::${type}::${canonicalLower}`
                     indexes:
                       - containerId   (single, for getAllByContainer)
```

Only one index in v1. After `getAllByContainer` loads the container's records (typically <5k entries, <10ms), recency filtering and alias regex run in memory. If observed container sizes start exceeding ~20k records, add a `(containerId, lastSeenOrder)` composite index for cheaper range queries — additive change, no migration needed.

The graph is **derived data**. Anything the snapshot store contains is authoritative; anything the graph contains can always be reconstructed from snapshots via `rebuildEntityGraph(containerId, snapshots)`.

### Container as the scope unit

`BookContainer` already groups one or more books (omnibus EPUBs are multi-book containers natively; separate EPUBs become one container after `handleAppendToSeries` merges them). Therefore "series-aware" = "container-scoped" with no new linkage UI needed.

The container's identifier (currently the originating book's `${title}::${author}` key) is reused as `containerId` for the entity-graph. When `handleAppendToSeries` extends a container, the graph extends with it — new chapter orders extend the existing range.

### Data flow

**Read path** (per-chapter analyze, runs three times: characters / locations / arcs prompt):

```
newChapterText
      ▼
retrieveContext(containerId, type, chapterText, chapterOrder, charBudget)
      ├─ getAll(containerId, type) from entity-graph         (1 IDB getAll)
      ├─ buildAliasRegex(records) → /\b(name|alias|...)\b/giu
      ├─ regex.exec(chapterText) → mentioned set
      ├─ filter records by lastSeenOrder ≥ chapterOrder − N  → recent set
      ├─ full = mentioned ∪ recent
      └─ sketch = trimSketch(others, charBudget − sizeOf(full))
      ▼
{ full: EntityRecord[], sketch: SketchEntry[] }
      ▼
buildCharactersDeltaPrompt(... , retrieved.full, retrieved.sketch)
buildLocationsDeltaPrompt(... , retrievedChars.full+sketch, retrievedLocs.full+sketch)
buildArcsDeltaPrompt(... , retrievedChars, retrievedLocs, retrievedArcs)
      ▼
callLLM (much smaller prompt — typically a single chunk now)
```

**Write path** (after each analyze chunk's full pipeline completes):

```
LLM delta → mergeDelta → reconcile → dedup → final AnalysisResult
      ├──▶ saveBookState (snapshots — unchanged)
      └──▶ syncFromResult(containerId, newResult, mentionedNames, chapterOrder)
                ├─ upsert every entity in newResult
                ├─ set lastSeenOrder = chapterOrder for mentioned-this-chunk entities;
                │   preserve existing lastSeenOrder otherwise
                └─ delete records absent from newResult; fold their lastSeenOrder
                    into any kept record that absorbed their alias
                    (handles reconcile renames / merges / splits implicitly)
```

## Detailed design

### Schema

```ts
// lib/entity-graph.ts

export type EntityType = 'character' | 'location' | 'arc';

export interface EntityRecord {
  // identity
  id: string;                // `${containerId}::${type}::${canonicalLower}`
  containerId: string;       // indexed (only index in v1)
  type: EntityType;
  canonicalName: string;
  canonicalLower: string;    // for case-insensitive in-memory lookups

  // recency
  lastSeenOrder: number;     // chapter ORDER (not index — across the container)

  // tiering signal
  importance?: 'main' | 'secondary' | 'minor';  // characters only; default 'secondary'

  // full data — the existing entity payload, stored verbatim.
  // Arcs have no `aliases` field; characters and locations do.
  payload: Character | LocationInfo | NarrativeArc;
}

export interface SketchEntry {
  name: string;
  aliases?: string[];        // shown to the LLM as: `- Name [aliases: a, b]`
}

export interface RetrievedContext<T> {
  full: T[];                 // full payloads for mentioned + recent
  sketch: SketchEntry[];     // lightweight name-only entries for the rest
  stats: {
    rosterSize: number;
    mentionedCount: number;
    recentCount: number;
    sketchTrimmed: number;   // how many were dropped to fit budget
  };
}
```

### retrieveContext algorithm

```ts
export async function retrieveContext<T>(
  containerId: string,
  type: EntityType,
  chapterText: string,
  chapterOrder: number,
  charBudget: number,
): Promise<RetrievedContext<T>> {
  const records = await entityGraph.getAllByContainer(containerId, type);
  if (records.length === 0) {
    return { full: [], sketch: [], stats: { rosterSize: 0, mentionedCount: 0, recentCount: 0, sketchTrimmed: 0 } };
  }

  const pattern = buildAliasRegex(records);
  const mentionedIds = pattern
    ? new Set(matchAliasesInText(records, pattern, chapterText))
    : new Set<string>();

  const recencyWindow = RECENCY_WINDOW[type];          // characters: 5, locations: 8, arcs: Infinity
  const recentIds = new Set(
    records.filter(r => r.lastSeenOrder >= chapterOrder - recencyWindow).map(r => r.id),
  );

  const fullIds = new Set([...mentionedIds, ...recentIds]);
  const full = records.filter(r => fullIds.has(r.id)).map(r => r.payload as T);
  const fullSize = estimateCharSize(full);

  const others = records.filter(r => !fullIds.has(r.id));
  const sketch = trimSketch(others, Math.max(0, charBudget - fullSize));

  return {
    full,
    sketch,
    stats: {
      rosterSize: records.length,
      mentionedCount: mentionedIds.size,
      recentCount: recentIds.size - intersectionSize(mentionedIds, recentIds),
      sketchTrimmed: others.length - sketch.length,
    },
  };
}
```

### buildAliasRegex

```ts
// Stopwords that would create false positives in chapter text
const STOPWORDS = new Set([
  'the', 'lord', 'lady', 'king', 'queen', 'sir',
  'father', 'mother', 'brother', 'sister',
  'captain', 'master', 'mistress', 'man', 'woman',
  // expand as we observe false positives in real books
]);

const MAX_ALIASES_PER_PATTERN = 5000;
const MAX_PATTERN_BYTES = 1_000_000;

export function buildAliasRegex(records: EntityRecord[]): RegExp | null {
  const aliasToRecord = new Map<string, EntityRecord>();
  for (const r of records) {
    for (const alias of [r.canonicalName, ...(r.payload as any).aliases ?? []]) {
      const lower = alias.toLowerCase().trim();
      if (lower.length < 3) continue;
      if (STOPWORDS.has(lower)) continue;
      if (!aliasToRecord.has(lower)) aliasToRecord.set(lower, r);
    }
  }

  const aliases = [...aliasToRecord.keys()]
    .sort((a, b) => b.length - a.length);   // longest first — "Matrim Cauthon" before "Mat"

  if (aliases.length === 0) return null;
  if (aliases.length > MAX_ALIASES_PER_PATTERN) {
    // Cap with the longest aliases — they carry the most signal
    aliases.length = MAX_ALIASES_PER_PATTERN;
  }

  const escaped = aliases.map(escapeRegex);
  const source = `\\b(${escaped.join('|')})\\b`;
  if (source.length > MAX_PATTERN_BYTES) {
    // Fall back to chunked compilation — return a multi-pattern wrapper
    return buildChunkedAliasRegex(aliases);
  }

  try {
    return new RegExp(source, 'giu');
  } catch (err) {
    console.warn('[entity-graph] regex compile failed, retrying with halved alias set', err);
    aliases.length = Math.floor(aliases.length / 2);
    return new RegExp(`\\b(${aliases.map(escapeRegex).join('|')})\\b`, 'giu');
  }
}
```

`matchAliasesInText` runs the compiled regex against the chapter text and resolves each match to the owning record's `id` (via the alias-to-record map captured in the closure). Returns a deduplicated array of record IDs.

### trimSketch and budget allocation

```ts
const RECENCY_WINDOW: Record<EntityType, number> = {
  character: 5,
  location: 8,
  arc: Infinity,   // arcs are capped at 8 records anyway; always include
};

const IMPORTANCE_RANK: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

export function trimSketch(others: EntityRecord[], charBudget: number): SketchEntry[] {
  // Sort: highest-priority kept (importance DESC, recency DESC)
  const sorted = [...others].sort((a, b) => {
    const ai = IMPORTANCE_RANK[a.importance ?? 'secondary'] ?? 2;
    const bi = IMPORTANCE_RANK[b.importance ?? 'secondary'] ?? 2;
    if (ai !== bi) return bi - ai;
    return b.lastSeenOrder - a.lastSeenOrder;
  });

  const kept: SketchEntry[] = [];
  let used = 0;
  for (const r of sorted) {
    const entry: SketchEntry = {
      name: r.canonicalName,
      aliases: (r.payload as any).aliases?.length ? (r.payload as any).aliases : undefined,
    };
    const cost = estimateSketchEntrySize(entry);
    if (used + cost > charBudget) break;
    kept.push(entry);
    used += cost;
  }
  return kept;
}
```

Budget carve-up inside the analyze route:

```
contextWindow
  − outputReserve         (fixed per provider — Anthropic 8k, Ollama 4k, etc.)
  − promptOverhead        (system + schema + instructions; ~3k–6k)
  = available
        ├── chapterTextBudget    = available (chapter text gets first claim)
        └── entityContextBudget  = min(0.4 × available, available − chapterTextLen)
                                   (capped at 40% to prevent entity-context starvation
                                    of the chapter text)

Inside entityContextBudget:
  fullEntities (mentioned ∪ recent) → no cap; emitted first
  sketchEntities → fills the remainder, trimmed by trimSketch
```

If even `fullEntities` exceeds `entityContextBudget` (an unusual chapter mentioning >250 distinct entities), the existing `splitChapterText` chunking path stays as the safety net.

### syncFromResult (write path)

The write path runs after each chunk's full analyze pipeline (`mergeDelta` + reconcile + dedup) produces the final `AnalysisResult`. It synchronizes the graph to match that result:

```ts
export async function syncFromResult(
  containerId: string,
  newResult: AnalysisResult,
  mentionedNames: { characters: Set<string>; locations: Set<string>; arcs: Set<string> },
  chapterOrder: number,
): Promise<void> {
  const tx = await graphTx('readwrite');
  const existing = await getAllByContainer(tx, containerId);
  const existingByKey = new Map(existing.map(r => [keyFor(r.type, r.canonicalName), r]));

  const validKeys = new Set<string>();

  for (const c of newResult.characters) {
    const key = keyFor('character', c.name);
    validKeys.add(key);
    const prev = existingByKey.get(key);
    const wasMentioned = mentionedNames.characters.has(c.name.toLowerCase());
    const lastSeen = wasMentioned ? chapterOrder : (prev?.lastSeenOrder ?? chapterOrder);
    await upsertEntity(tx, containerId, 'character', c, lastSeen);
  }
  // ... same for locations and arcs

  // Delete records absent from newResult — handles reconcile renames/merges/splits
  // naturally: the absorbed name disappears, the kept name takes over.
  // When the deleted name appears as an alias of a kept record, fold its
  // lastSeenOrder into the kept record (take the max).
  for (const r of existing) {
    if (validKeys.has(keyFor(r.type, r.canonicalName))) continue;
    const absorber = findAbsorberByAlias(r, newResult);
    if (absorber) {
      await mergeLastSeen(tx, containerId, absorber, r.lastSeenOrder);
    }
    await deleteEntity(tx, r.id);
  }
}
```

`mentionedNames` is derived from `chunkDelta` (the entities the LLM said appear in this chunk's text — already computed for the existing `chunkDelta` payload in the analyze route).

Reconcile renames, merges, and splits are absorbed implicitly: the final `newResult` reflects the resolved state, and `syncFromResult` makes the graph match. This collapses what would otherwise be three separate primitives (rename / merge / split) into a single sync operation.

### rebuildEntityGraph

```ts
export async function rebuildEntityGraph(
  containerId: string,
  snapshots: AnalysisSnapshot[],
): Promise<void> {
  const tx = await graphTx('readwrite');

  // 1. Wipe records for this container
  await deleteByContainer(tx, containerId);

  // 2. Walk snapshots in chapter order (snapshots are stored per chapter,
  //    so iteration order is naturally chronological)
  const ordered = [...snapshots].sort((a, b) => a.chapterOrder - b.chapterOrder);
  for (const snap of ordered) {
    for (const c of snap.result.characters) {
      await upsertEntity(tx, containerId, 'character', c, snap.chapterOrder);
    }
    for (const l of snap.result.locations ?? []) {
      await upsertEntity(tx, containerId, 'location', l, snap.chapterOrder);
    }
    for (const a of snap.result.arcs ?? []) {
      await upsertEntity(tx, containerId, 'arc', a, snap.chapterOrder);
    }
  }
}
```

Single IDB transaction. Estimated cost: ~500ms for a WoT-scale container (14 books × ~50 chapters each × ~50 entities/chapter ≈ 35,000 upserts). Acceptable to run synchronously on click for rollback or container-edit triggers; ran behind a brief spinner for migration backfill.

## Lifecycle & invariants

| Trigger | Graph action | Cost |
|---|---|---|
| `analyze` per chunk (incl. reconcile + dedup) | `syncFromResult(containerId, newResult, mentionedNames, chapterOrder)` | O(roster) |
| `propagateEdit` (user edits in UI) | `rebuildEntityGraph(containerId, snapshots)` after the existing snapshot-side propagation | O(K × roster) |
| Rollback to chapter K | `rebuildEntityGraph(containerId, snapshots[0..K])` | O(K × roster) |
| Container edit (exclude chapter, move boundary) | `rebuildEntityGraph(containerId, filteredSnapshots)` | O(K × roster) |
| Book deleted | `deleteByContainer(containerId)` | O(records) |
| Upgrade with no graph for this container yet | Lazy: `rebuildEntityGraph` on next `retrieveContext` call (one-time) | O(K × roster), one-time |

`syncFromResult` is the only **incremental** path — every other mutation funnels through `rebuildEntityGraph`. That keeps the invariant story to two primitives.

### Failure modes

| Failure | Behavior |
|---|---|
| Graph missing for container | `retrieveContext` falls back to today's `compactCharacterList(result.characters)` and full location/arc summaries (i.e., current behavior). Schedules a lazy backfill in the background. |
| Graph corrupt / IDB error | Log + fall back as above. User sees no breakage, just no context trimming this chapter. |
| Regex compile fails (malformed alias) | Drop the offending alias, recompile. If retries exhaust, fall back to the no-graph path. |
| Rebuild crashes mid-transaction | IDB rolls back; graph keeps its prior state. Next read triggers another rebuild. |
| Chapter mentions >250 entities (fullSize > budget) | Existing `splitChapterText` chunking kicks in as today. Log the case so we can investigate. |

### Migration

- On `openDB`, the `onupgradeneeded` handler runs at version 1 → 2 and creates the `entity-graph` store with the indexes listed in the schema section.
- No data migration runs at upgrade time. Existing books continue to work via the fallback path described above.
- The first time `retrieveContext` is called for a container that has no graph records, `rebuildEntityGraph(containerId, snapshots)` is triggered synchronously (with a spinner if it takes >100ms). Subsequent calls hit the populated graph directly.
- `lastSeenOrder` during backfill is set from each snapshot's `chapterOrder`. For entities present in the final merged `AnalysisResult` but whose origin chapter cannot be determined, `lastSeenOrder` defaults to the latest chapter — conservatively making them eligible for the recency window.

## Files touched

- `lib/book-storage.ts` — bump `DB_VERSION` to 2, add `entity-graph` store + indexes in `onupgradeneeded`.
- `lib/entity-graph.ts` — **new.** Schema, `getAllByContainer`, `upsertEntity`, `deleteEntity`, `deleteByContainer`, `syncFromResult`, `rebuildEntityGraph`, transaction helpers.
- `lib/retrieve-context.ts` — **new.** `retrieveContext`, `buildAliasRegex`, `matchAliasesInText`, `trimSketch`, `estimateCharSize`, `estimateSketchEntrySize`.
- `lib/ai-shared.ts` — update `compactCharacterList` and add new helpers that take retrieved contexts and format them as the LLM-facing prompt sections. Existing call sites switch to the new helpers.
- `app/api/analyze/route.ts` — call `retrieveContext` before each of the three prompt-build steps; call `syncFromResult` after each chunk completes its full pipeline (post-reconcile, post-dedup). Wire `containerId` through from the request body. Compute `mentionedNames` from the existing `chunkDelta`.
- `lib/ai-client.ts` — same as the route, for the client-side analysis path (mobile / static PWA).
- `lib/propagate-edit.ts` — call `rebuildEntityGraph(containerId, snapshots)` after the existing snapshot-side propagation completes. Simplest invariant: every UI-driven edit funnels through rebuild.
- `app/page.tsx` — trigger `rebuildEntityGraph` after rollback and container-edit operations.
- `package.json` — add `vitest` and `@vitest/coverage-v8` as devDependencies; add `test` script.
- `vitest.config.ts` — **new.** Basic node-environment config; `lib/**/*.test.ts` glob.
- `lib/__tests__/entity-graph.test.ts` — **new.**
- `lib/__tests__/retrieve-context.test.ts` — **new.**
- `lib/__tests__/build-alias-regex.test.ts` — **new.**

## Testing strategy

### Unit tests (new — adds vitest as dev dependency)

| Function | Cases |
|---|---|
| `buildAliasRegex` | empty input; stopword filter; length-3 filter; longest-first ordering (verify "Matrim Cauthon" matches before "Mat"); regex compile failure recovery; alias-count cap |
| `trimSketch` | budget = 0; budget > total size (returns all); budget cuts mid-list; importance ordering preserved; ties broken by recency |
| `retrieveContext` | empty graph (returns empty result); mentioned-only; recent-only; mentioned + recent overlap; sketch trimming under tight budget; pattern miss returns 0 mentioned |
| `syncFromResult` | new entity inserted; `lastSeenOrder` set for mentioned, preserved for not-mentioned; record absent from `newResult` deleted; deleted record's `lastSeenOrder` folded into absorber when its name appears in absorber's aliases (reconcile-rename case); merge case (two records → one); split case (one record → two) |
| `rebuildEntityGraph` | empty snapshot list (wipes container); single snapshot; multiple snapshots produce same final state as iterative `syncFromResult` calls from the same chunkDeltas (the key invariant — proves the two write paths agree) |

### Manual test plan (executed against the dev server)

1. Upload a small book (10–20 chapters) → verify `entity-graph` populates by inspecting IDB.
2. Roll back to an earlier chapter → verify graph rebuilds and `lastSeenOrder` resets correctly for affected entities.
3. Rename a character via the UI → verify graph reflects the rename (canonical name updated, alias added).
4. Append a 2nd EPUB to the series via `SeriesPicker` → verify the graph extends (records from book 1 still present; new records from book 2 added with extended `lastSeenOrder` range).
5. WoT omnibus through ≥3 books → verify no chunking is triggered on chapters that previously chunked. Check console for `[retrieve] stats: full=N, sketch=M, trimmed=K` debug output.
6. Toggle the entity-graph off via a debug flag in localStorage (`bookbuddy-disable-entity-graph=1`) → verify the fallback path produces identical behavior to pre-change.
7. Trigger a chapter that mentions >250 entities (synthetic test EPUB) → verify the `splitChapterText` safety net engages.

### Debug instrumentation

Behind `NEXT_PUBLIC_DEBUG_RETRIEVAL=1` (or the same localStorage flag), each `retrieveContext` call logs:

```
[retrieve] container=<id> type=character chapter=42
  rosterSize=2734  mentioned=18  recent=12 (4 overlap)
  full=26 (3812 chars)  sketch=89 (2103 chars, 2619 trimmed)
  budget=6000 chars  used=5915 chars
```

Enough to confirm the budget shaping works without bloating prod logs.

## Future-extensibility hooks (deliberately built in, not implemented)

- **Chat-time queries.** `retrieveContext` already takes a `chapterText` parameter; a chat UI could pass the user's question instead and get back the same `{ full, sketch }` shape to feed into a chat prompt.
- **Cross-container queries.** `getAllByContainer` would generalize to `getAllByContainerSet([id1, id2, ...])` — additive change, no schema impact.
- **Semantic / embedding-based recall.** Adding a `vector?: Float32Array` field to `EntityRecord` is non-breaking; a parallel `getByVectorSimilarity` retrieval path could be layered alongside the regex path.

## Open questions

None blocking. Decisions left to implementation:

- Exact stopword list — will be tuned by inspecting false-positive matches during manual testing on real books.
- Whether to expose recency-window N as a user-facing setting or hardcode the defaults — default to hardcoded for now; revisit if users report bad results.
