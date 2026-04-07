# Chapter Event Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve all narrative content from chunked chapters by capturing each chunk's extraction output as a discrete ChapterEvent, enabling multiple timeline entries per chapter with sub-chapter position tracking.

**Architecture:** Modify the existing chunk processing loop in `route.ts` to capture each chunk's delta output as a `ChapterEvent` before merging forward. The API returns events alongside the result. `StoryTimeline` renders multiple event cards per chapter grouped under chapter headers. Reading position gains sub-chapter granularity via a progress float.

**Tech Stack:** Next.js, TypeScript, React, existing LLM extraction pipeline (unchanged prompts/schemas)

---

### Task 1: Add new types

**Files:**
- Modify: `types/index.ts:96-108` (AnalysisResult area), `types/index.ts:149-160` (StoredBookState)

- [ ] **Step 1: Add ChapterEvent and ReadingPosition interfaces**

In `types/index.ts`, add after the `AnalysisResult` interface (after line 101):

```typescript
export interface ChapterEvent {
  summary: string;
  characters: string[];
  locations: string[];
  characterSnapshots: Character[];
  locationSnapshots: LocationInfo[];
  arcSnapshots?: NarrativeArc[];
  chapterProgress: number;
  textAnchor?: string;
}

export interface ReadingPosition {
  chapterIndex: number;
  progress?: number;
}
```

- [ ] **Step 2: Add events field to Snapshot**

In `types/index.ts`, update the `Snapshot` interface (line 103-108) to add the `events` field:

```typescript
export interface Snapshot {
  index: number;
  result: AnalysisResult;
  events?: ChapterEvent[];
  model?: string;
  appVersion?: string;
}
```

- [ ] **Step 3: Add readingPosition to StoredBookState**

In `types/index.ts`, add `readingPosition` to `StoredBookState` (after line 157):

```typescript
  readingPosition?: ReadingPosition;
```

- [ ] **Step 4: Commit**

```bash
git add types/index.ts
git commit -m "feat: add ChapterEvent, ReadingPosition types and Snapshot.events field"
```

---

### Task 2: Add textAnchor helper and modify runMultiPassDelta return type

**Files:**
- Modify: `app/api/analyze/route.ts:1659-1785`

- [ ] **Step 1: Add extractTextAnchor helper**

In `app/api/analyze/route.ts`, add this helper near the other utility functions (after the `normLoc` function around line 522):

```typescript
/** Extract the first ~100 chars of text, trimmed to a word boundary. */
function extractTextAnchor(text: string, maxLen = 100): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  const trimmed = clean.slice(0, maxLen);
  const lastSpace = trimmed.lastIndexOf(' ');
  return (lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed).trim();
}
```

- [ ] **Step 2: Add ChunkDelta type and update runMultiPassDelta return type**

In `app/api/analyze/route.ts`, add a type near the other type aliases at the top of the file (around line 20, near existing type aliases):

```typescript
interface ChunkDelta {
  characters: Character[];
  locations: LocationInfo[];
  arcs: NarrativeArc[];
  summary: string;
}
```

Then update the `runMultiPassDelta` function signature (line 1659) to return the delta alongside the result:

Change:
```typescript
): Promise<{ result: AnalysisResult; totalRateLimitMs: number }> {
```
To:
```typescript
): Promise<{ result: AnalysisResult; totalRateLimitMs: number; chunkDelta: ChunkDelta }> {
```

- [ ] **Step 3: Capture delta data before final return in runMultiPassDelta**

At line 1783-1784, change the return statement from:

```typescript
  console.log(`[analyze] Delta complete: ${groupedCharacters.length} chars, ${finalResult.arcs?.length ?? 0} arcs, ${groupedLocations?.length ?? 0} locs`);
  return { result: { ...finalResult, locations: groupedLocations, characters: groupedCharacters }, totalRateLimitMs };
```

To:

```typescript
  console.log(`[analyze] Delta complete: ${groupedCharacters.length} chars, ${finalResult.arcs?.length ?? 0} arcs, ${groupedLocations?.length ?? 0} locs`);
  const chunkDelta: ChunkDelta = {
    characters: deltaChars,
    locations: groundedDeltaLocs,
    arcs: sanitizeLLMArcs(arcDelta.updatedArcs ?? []),
    summary: locDelta.summary ?? '',
  };
  return { result: { ...finalResult, locations: groupedLocations, characters: groupedCharacters }, totalRateLimitMs, chunkDelta };
```

Note: `deltaChars` is defined at line 1681, `groundedDeltaLocs` at line 1730, `arcDelta.updatedArcs` at line 1750, `locDelta.summary` at line 1732. These are all already in scope at the return point.

- [ ] **Step 4: Verify the build compiles**

Run: `npx next build 2>&1 | head -30`

Expected: No type errors related to `runMultiPassDelta`. There will be warnings at the call sites (lines 1868, 1905) because they don't destructure `chunkDelta` yet — that's fine, we fix those in the next task.

- [ ] **Step 5: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat: add ChunkDelta return type to runMultiPassDelta and textAnchor helper"
```

---

### Task 3: Capture events in the delta chunk processing loop

**Files:**
- Modify: `app/api/analyze/route.ts:1840-1874`

This is the `isDelta` branch — when processing new chapters against a previous result.

- [ ] **Step 1: Add import for ChapterEvent type**

At the top of `app/api/analyze/route.ts`, ensure the import from `@/types` includes `ChapterEvent`:

Find the existing import line (should be near the top) and add `ChapterEvent` to it. For example, if it currently reads:
```typescript
import type { AnalysisResult, Character, ... } from '@/types';
```
Add `ChapterEvent` to the list.

- [ ] **Step 2: Update the delta chunk loop to capture events**

Replace lines 1862-1874 (the delta chunk loop):

```typescript
      let accumulated: AnalysisResult = previousResult!;

      for (const chunk of chunks) {
        if (chunks.length > 1) {
          console.log(`[analyze] Chapter "${currentChapterTitle}" chunk ${chunk.index + 1}/${chunk.total} (${chunk.text.length} chars)`);
        }
        const { result: chunkResult, totalRateLimitMs: chunkRl } = await runMultiPassDelta(
          bookTitle, bookAuthor, currentChapterTitle, chunk.text, accumulated, config, contextWindow,
        );
        totalRateLimitMs += chunkRl;
        accumulated = chunkResult;
      }
      result = accumulated;
```

With:

```typescript
      let accumulated: AnalysisResult = previousResult!;
      const events: ChapterEvent[] = [];

      for (const chunk of chunks) {
        if (chunks.length > 1) {
          console.log(`[analyze] Chapter "${currentChapterTitle}" chunk ${chunk.index + 1}/${chunk.total} (${chunk.text.length} chars)`);
        }
        const { result: chunkResult, totalRateLimitMs: chunkRl, chunkDelta } = await runMultiPassDelta(
          bookTitle, bookAuthor, currentChapterTitle, chunk.text, accumulated, config, contextWindow,
        );
        totalRateLimitMs += chunkRl;
        events.push({
          summary: chunkDelta.summary,
          characters: chunkDelta.characters.map((c) => c.name),
          locations: chunkDelta.locations.map((l) => l.name),
          characterSnapshots: chunkDelta.characters,
          locationSnapshots: chunkDelta.locations,
          arcSnapshots: chunkDelta.arcs.length > 0 ? chunkDelta.arcs : undefined,
          chapterProgress: (chunk.index + 0.5) / chunk.total,
          textAnchor: extractTextAnchor(chunk.text),
        });
        accumulated = chunkResult;
      }
      result = accumulated;
```

- [ ] **Step 3: Include events in the response**

At line 1914, change:

```typescript
    return NextResponse.json({ ...result, _model: modelName, _rateLimitWaitMs: totalRateLimitMs || undefined });
```

To:

```typescript
    return NextResponse.json({ ...result, _events: events, _model: modelName, _rateLimitWaitMs: totalRateLimitMs || undefined });
```

Note: We need `events` to be in scope for both the delta and full-analysis paths. Declare `let events: ChapterEvent[] = [];` before the `if (isDelta)` block (before line 1844) and remove the `const events` declaration from inside the delta block. We'll do the full-analysis path in the next task, so for now just hoist the declaration.

Update: change the delta block's `const events` to just use the hoisted variable. The full code change around line 1841-1844:

```typescript
    let result: AnalysisResult;
    let totalRateLimitMs = 0;
    let events: ChapterEvent[] = [];

    if (isDelta) {
```

- [ ] **Step 4: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat: capture chunk events in delta processing loop"
```

---

### Task 4: Capture events in the full-analysis chunk processing loop

**Files:**
- Modify: `app/api/analyze/route.ts:1895-1911`

This is the `else` branch — first-time full analysis.

- [ ] **Step 1: Capture event from the first chunk (full analysis)**

After line 1900 (`let accumulated = firstResult;`), add:

```typescript
      events.push({
        summary: firstResult.summary,
        characters: firstResult.characters.map((c) => c.name),
        locations: (firstResult.locations ?? []).map((l) => l.name),
        characterSnapshots: firstResult.characters,
        locationSnapshots: firstResult.locations ?? [],
        arcSnapshots: firstResult.arcs,
        chapterProgress: (0 + 0.5) / chunks[0].total,
        textAnchor: extractTextAnchor(chunks[0].text),
      });
```

- [ ] **Step 2: Update the subsequent chunks loop to capture events**

Replace lines 1902-1910:

```typescript
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[analyze] Chapter "${currentChapterTitle}" chunk ${chunk.index + 1}/${chunk.total} (${chunk.text.length} chars)`);
        const { result: chunkResult, totalRateLimitMs: chunkRl } = await runMultiPassDelta(
          bookTitle, bookAuthor, currentChapterTitle, chunk.text, accumulated, config, contextWindow,
        );
        totalRateLimitMs += chunkRl;
        accumulated = chunkResult;
      }
```

With:

```typescript
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[analyze] Chapter "${currentChapterTitle}" chunk ${chunk.index + 1}/${chunk.total} (${chunk.text.length} chars)`);
        const { result: chunkResult, totalRateLimitMs: chunkRl, chunkDelta } = await runMultiPassDelta(
          bookTitle, bookAuthor, currentChapterTitle, chunk.text, accumulated, config, contextWindow,
        );
        totalRateLimitMs += chunkRl;
        events.push({
          summary: chunkDelta.summary,
          characters: chunkDelta.characters.map((c) => c.name),
          locations: chunkDelta.locations.map((l) => l.name),
          characterSnapshots: chunkDelta.characters,
          locationSnapshots: chunkDelta.locations,
          arcSnapshots: chunkDelta.arcs.length > 0 ? chunkDelta.arcs : undefined,
          chapterProgress: (chunk.index + 0.5) / chunk.total,
          textAnchor: extractTextAnchor(chunk.text),
        });
        accumulated = chunkResult;
      }
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx next build 2>&1 | head -30`

Expected: Clean compile. The API now returns `_events` in the response JSON.

- [ ] **Step 4: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat: capture chunk events in full-analysis processing loop"
```

---

### Task 5: Update client to receive and store events

**Files:**
- Modify: `app/page.tsx:64-67` (upsertSnapshot), `app/page.tsx:129-137` (analyzeChapter)

- [ ] **Step 1: Update analyzeChapter to extract events from response**

At line 134, change:

```typescript
  const data = await res.json() as AnalysisResult & { _model?: string; _rateLimitWaitMs?: number };
  if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? 'Analysis failed.');
  const { _model, _rateLimitWaitMs, ...result } = data;
  return { result: result as AnalysisResult, model: _model ?? 'unknown', rateLimitWaitMs: _rateLimitWaitMs };
```

To:

```typescript
  const data = await res.json() as AnalysisResult & { _model?: string; _rateLimitWaitMs?: number; _events?: ChapterEvent[] };
  if (!res.ok) throw new Error((data as unknown as { error?: string }).error ?? 'Analysis failed.');
  const { _model, _rateLimitWaitMs, _events, ...result } = data;
  return { result: result as AnalysisResult, model: _model ?? 'unknown', rateLimitWaitMs: _rateLimitWaitMs, events: _events };
```

Make sure the import at the top of `page.tsx` includes `ChapterEvent`:

```typescript
import type { AnalysisResult, ..., ChapterEvent } from '@/types';
```

- [ ] **Step 2: Update upsertSnapshot to accept events**

At line 64-66, change:

```typescript
function upsertSnapshot(snapshots: Snapshot[], index: number, result: AnalysisResult, model?: string, appVersion?: string): Snapshot[] {
  const without = snapshots.filter((s) => s.index !== index);
  return [...without, { index, result, ...(model ? { model } : {}), ...(appVersion ? { appVersion } : {}) }];
}
```

To:

```typescript
function upsertSnapshot(snapshots: Snapshot[], index: number, result: AnalysisResult, model?: string, appVersion?: string, events?: ChapterEvent[]): Snapshot[] {
  const without = snapshots.filter((s) => s.index !== index);
  return [...without, { index, result, ...(model ? { model } : {}), ...(appVersion ? { appVersion } : {}), ...(events?.length ? { events } : {}) }];
}
```

- [ ] **Step 3: Pass events through at the primary analysis call site**

At line 929-933, change:

```typescript
          const { result: chResult, model: chModel } = await analyzeChapter(title, author, { title: ch.title, text: ch.text }, accumulated, chapters.map((c) => c.title));
          accumulated = chResult;
          recentText += `\n=== ${ch.title} ===\n${ch.text}`;
          if (recentText.length > MAX_RECENT_TEXT) recentText = recentText.slice(-MAX_RECENT_TEXT);
          snapshots = upsertSnapshot(snapshots, i, accumulated, chModel, APP_VERSION);
```

To:

```typescript
          const { result: chResult, model: chModel, events: chEvents } = await analyzeChapter(title, author, { title: ch.title, text: ch.text }, accumulated, chapters.map((c) => c.title));
          accumulated = chResult;
          recentText += `\n=== ${ch.title} ===\n${ch.text}`;
          if (recentText.length > MAX_RECENT_TEXT) recentText = recentText.slice(-MAX_RECENT_TEXT);
          snapshots = upsertSnapshot(snapshots, i, accumulated, chModel, APP_VERSION, chEvents);
```

- [ ] **Step 4: Update other upsertSnapshot call sites**

There are several other `upsertSnapshot` calls in `page.tsx` (lines 906, 918, 952, 972, 1294, 1340, 1386). These are for reconciliation, carry-forward, and rebuild paths — they don't go through the chunking pipeline, so they can pass `undefined` for events (the parameter is already optional). No changes needed for these call sites.

- [ ] **Step 5: Verify the build compiles**

Run: `npx next build 2>&1 | head -30`

Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx
git commit -m "feat: pass chunk events from API through to snapshot storage"
```

---

### Task 6: Update StoryTimeline to render multiple events per chapter

**Files:**
- Modify: `components/StoryTimeline.tsx`

- [ ] **Step 1: Add ChapterEvent to imports**

At line 4, update the import:

```typescript
import type { AnalysisResult, ChapterEvent, PinUpdates, Snapshot } from '@/types';
```

- [ ] **Step 2: Replace the single-card-per-chapter rendering with event groups**

Replace the entries map block (lines 83-191) with a new implementation that groups events under chapter headers. The full replacement for lines 82-192:

```typescript
              <div className="space-y-5">
                {entries.map((snap, entryIdx) => {
                  const isCurrent = snap.index === currentIndex;
                  const prevResult = entries[entryIdx - 1]?.result;
                  const events: Array<{ summary: string; characters: string[]; locations: string[]; arcNames: string[] }> =
                    snap.events?.length
                      ? snap.events.map((ev) => ({
                          summary: ev.summary,
                          characters: ev.characters,
                          locations: ev.locations,
                          arcNames: (ev.arcSnapshots ?? []).filter((a) => a.status === 'active').map((a) => a.name),
                        }))
                      : [buildLegacyEvent(snap, prevResult)];

                  return (
                    <div key={snap.index} ref={isCurrent ? currentRef : undefined}>
                      {/* Chapter header */}
                      <div className="relative pl-8 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-medium text-stone-400 dark:text-zinc-500 bg-stone-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                            Ch {snap.index + 1}
                          </span>
                          <span className="text-sm font-semibold text-stone-800 dark:text-zinc-200 truncate">
                            {chapterTitles[snap.index] ?? `Chapter ${snap.index + 1}`}
                          </span>
                        </div>
                      </div>

                      {/* Event cards */}
                      {events.map((ev, evIdx) => {
                        const isLastEvent = isCurrent && evIdx === events.length - 1;
                        return (
                          <div
                            key={evIdx}
                            className={`relative pl-8 cursor-pointer group transition-colors rounded-lg p-3 -ml-3 ${
                              isLastEvent
                                ? 'bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-300 dark:ring-amber-700'
                                : 'hover:bg-stone-50 dark:hover:bg-zinc-800/50'
                            }`}
                            onClick={() => onJumpToChapter(snap.index)}
                          >
                            {/* Dot marker */}
                            <div
                              className={`absolute left-[5px] top-[18px] w-[10px] h-[10px] rounded-full border-2 ${
                                isLastEvent
                                  ? 'bg-amber-400 border-amber-500 dark:bg-amber-500 dark:border-amber-400'
                                  : 'bg-white dark:bg-zinc-900 border-stone-300 dark:border-zinc-600 group-hover:border-stone-400 dark:group-hover:border-zinc-500'
                              }`}
                            />

                            {/* Summary */}
                            <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">
                              {ev.summary}
                            </p>

                            {/* Entity tags */}
                            {(ev.characters.length > 0 || ev.locations.length > 0 || ev.arcNames.length > 0) && (
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {ev.characters.slice(0, 3).map((name) => (
                                  <button
                                    key={`char-${name}`}
                                    onClick={(e) => { e.stopPropagation(); setSelectedCharacter(name); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors"
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                                    </svg>
                                    {name}
                                  </button>
                                ))}
                                {ev.arcNames.slice(0, 2).map((name) => (
                                  <button
                                    key={`arc-${name}`}
                                    onClick={(e) => { e.stopPropagation(); setSelectedArc(name); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                                  >
                                    {name}
                                  </button>
                                ))}
                                {ev.locations.slice(0, 2).map((name) => (
                                  <button
                                    key={`loc-${name}`}
                                    onClick={(e) => { e.stopPropagation(); setSelectedLocation(name); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors"
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                    </svg>
                                    {name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
```

- [ ] **Step 3: Add the buildLegacyEvent helper**

Add this function inside the component, before the `return` statement (after the `useEffect` hooks, around line 47):

```typescript
  function buildLegacyEvent(snap: Snapshot, prevResult?: AnalysisResult): { summary: string; characters: string[]; locations: string[]; arcNames: string[] } {
    const prevCharMap = new Map(prevResult?.characters.map((c) => [c.name, c]) ?? []);
    const characters = snap.result.characters
      .filter((c) => {
        if (c.importance !== 'main') return false;
        const prev = prevCharMap.get(c.name);
        return !prev || prev.lastSeen !== c.lastSeen || prev.recentEvents !== c.recentEvents;
      })
      .slice(0, 3)
      .map((c) => c.name);

    const prevLocMap = new Map((prevResult?.locations ?? []).map((l) => [l.name, l]) ?? []);
    const locations = (snap.result.locations ?? [])
      .filter((l) => {
        if (!l.recentEvents) return false;
        const prev = prevLocMap.get(l.name);
        return !prev || prev.recentEvents !== l.recentEvents;
      })
      .slice(0, 2)
      .map((l) => l.name);

    const chapterCharNames = new Set(characters);
    const arcNames = (snap.result.arcs ?? [])
      .filter((a) => a.status === 'active' && a.characters.some((n) => chapterCharNames.has(n)))
      .slice(0, 2)
      .map((a) => a.name);

    return { summary: snap.result.summary, characters, locations, arcNames };
  }
```

- [ ] **Step 4: Verify the app renders correctly**

Run: `npm run dev`

Open the StoryTimeline on a book that has been processed. Existing snapshots (without events) should render as before using the legacy fallback. New snapshots processed on a small-context model should show multiple event cards per chapter.

- [ ] **Step 5: Commit**

```bash
git add components/StoryTimeline.tsx
git commit -m "feat: render multiple event cards per chapter in StoryTimeline"
```

---

### Task 7: Add reading position filtering to StoryTimeline

**Files:**
- Modify: `components/StoryTimeline.tsx`

- [ ] **Step 1: Add ReadingPosition to imports and props**

Update the import at line 4:

```typescript
import type { AnalysisResult, ChapterEvent, PinUpdates, ReadingPosition, Snapshot } from '@/types';
```

Add to `StoryTimelineProps` interface:

```typescript
  readingPosition?: ReadingPosition;
```

Update the destructuring in the component signature to include `readingPosition`.

- [ ] **Step 2: Filter entries and events by reading position**

After the `entries` const (line 27-29), add the filtering logic:

```typescript
  const visibleEntries = readingPosition
    ? entries.filter((s) => s.index <= readingPosition.chapterIndex)
    : entries;
```

Then update the rendering to use `visibleEntries` instead of `entries`, and filter events within the reading-position chapter:

In the `events` computation inside the map, wrap it with progress filtering:

```typescript
                  const allEvents: Array<{ summary: string; characters: string[]; locations: string[]; arcNames: string[] }> =
                    snap.events?.length
                      ? snap.events.map((ev) => ({
                          summary: ev.summary,
                          characters: ev.characters,
                          locations: ev.locations,
                          arcNames: (ev.arcSnapshots ?? []).filter((a) => a.status === 'active').map((a) => a.name),
                        }))
                      : [buildLegacyEvent(snap, prevResult)];

                  // Filter events by reading position progress within the current chapter
                  const events = readingPosition && snap.index === readingPosition.chapterIndex && readingPosition.progress != null
                    ? allEvents.filter((_, evIdx) => {
                        const evProgress = snap.events?.[evIdx]?.chapterProgress ?? 0.5;
                        return evProgress <= readingPosition.progress!;
                      })
                    : allEvents;
                  if (events.length === 0) return null;
```

- [ ] **Step 3: Update the "current" highlight logic**

Change the `isLastEvent` check to highlight the last visible event across all chapters (not just within the current chapter). Replace:

```typescript
                        const isLastEvent = isCurrent && evIdx === events.length - 1;
```

With:

```typescript
                        const isLastVisible = snap.index === visibleEntries[visibleEntries.length - 1]?.index && evIdx === events.length - 1;
```

Use `isLastVisible` in place of `isLastEvent` for the two class-name checks in the event card and dot marker.

- [ ] **Step 4: Add tap-to-set-position on event cards**

Add an `onSetReadingPosition` callback prop to `StoryTimelineProps`:

```typescript
  onSetReadingPosition?: (position: ReadingPosition) => void;
```

Update the destructuring to include it.

On each event card, add a small bookmark button (only shown on hover) that sets the reading position to that event's chapter + progress:

Inside the event card div, after the entity tags block, add:

```typescript
                            {onSetReadingPosition && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const progress = snap.events?.[evIdx]?.chapterProgress;
                                  onSetReadingPosition({ chapterIndex: snap.index, progress });
                                }}
                                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-stone-400 dark:text-zinc-500 hover:text-stone-600 dark:hover:text-zinc-300"
                                title="Set reading position here"
                              >
                                <svg width="12" height="16" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                                  <path d="M1 1h8v12l-4-3-4 3V1z" />
                                </svg>
                              </button>
                            )}
```

- [ ] **Step 5: Commit**

```bash
git add components/StoryTimeline.tsx
git commit -m "feat: filter timeline events by reading position with tap-to-set"
```

---

### Task 8: Wire reading position into page.tsx

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add ReadingPosition import and state**

Add `ReadingPosition` to the existing type import from `@/types`.

Find where `readingBookmark` state is used (around line 1692) and add alongside it:

```typescript
  const readingPosition: ReadingPosition | undefined = stored?.readingPosition ?? (
    stored?.readingBookmark != null ? { chapterIndex: stored.readingBookmark } : undefined
  );
```

This derives `ReadingPosition` from either the new field or the legacy `readingBookmark`, providing backward compatibility.

- [ ] **Step 2: Add handleSetReadingPosition handler**

Near the existing `handleSetBookmark` function (line 478), add:

```typescript
  function handleSetReadingPosition(position: ReadingPosition) {
    if (!stored) return;
    const updated: StoredBookState = { ...stored, readingPosition: position, readingBookmark: position.chapterIndex };
    persistState(book!.title, book!.author, updated);
    storedRef.current = updated;
    setCurrentIndex(position.chapterIndex);
    const snap = bestSnapshot(updated.snapshots, position.chapterIndex);
    if (snap) setResult(snap.result);
  }
```

- [ ] **Step 3: Pass readingPosition and handler to StoryTimeline**

Find where `StoryTimeline` is rendered (search for `<StoryTimeline`). Add the props:

```typescript
  readingPosition={readingPosition}
  onSetReadingPosition={handleSetReadingPosition}
```

- [ ] **Step 3: Verify end-to-end flow**

Run: `npm run dev`

1. Open a book and process a long chapter on a local model with small context
2. Open StoryTimeline — verify multiple event cards appear for the chunked chapter
3. Set a bookmark — verify events beyond that position are hidden
4. Verify short chapters (single chunk) still show one event card
5. Verify pre-existing snapshots (no events field) render with the legacy single-card fallback

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: wire reading position into StoryTimeline for sub-chapter filtering"
```
