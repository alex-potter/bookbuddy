# Parent Story Arcs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a book is fully analyzed, automatically group narrative arcs into ≤5 parent arcs via an AI call, with collapsible UI grouping in ArcsPanel and consolidated SubwayMap lanes.

**Architecture:** New API route (`app/api/group-arcs/route.ts`) handles the AI grouping call. A shared helper `maybeGenerateParentArcs` fires from all three analysis flows after completion. `parentArcs` is stored as an optional field on `StoredBookState`. ArcsPanel renders collapsible parent sections with inline editing. SubwayMap uses parent arc names for lane assignment.

**Tech Stack:** Next.js 14 (App Router), React, TypeScript, Tailwind CSS, Anthropic Claude API

**Spec:** `docs/superpowers/specs/2026-03-26-parent-arcs-design.md`

---

### Task 1: Add ParentArc type and StoredBookState field

**Files:**
- Modify: `types/index.ts:59-64` (after NarrativeArc interface)
- Modify: `app/page.tsx:42-51` (StoredBookState interface)

- [ ] **Step 1: Add ParentArc interface to types/index.ts**

After the existing `NarrativeArc` interface (line 64), add:

```typescript
export interface ParentArc {
  name: string;
  children: string[];  // child arc names, ordered
  summary: string;     // AI-generated summary of the grouped theme
}
```

- [ ] **Step 2: Add parentArcs to StoredBookState**

In `app/page.tsx`, add `parentArcs` to the `StoredBookState` interface (after `readingBookmark` on line 50):

```typescript
  parentArcs?: ParentArc[];
```

Also add the import at the top of `page.tsx` — `ParentArc` must be added to the existing import from `@/types` (line 6):

```typescript
import type { ..., ParentArc } from '@/types';
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean (no errors)

- [ ] **Step 4: Commit**

```bash
git add types/index.ts app/page.tsx
git commit -m "feat: add ParentArc type and StoredBookState field"
```

---

### Task 2: Create group-arcs API route

**Files:**
- Create: `app/api/group-arcs/route.ts`

This route follows the same patterns as `app/api/analyze/route.ts`: reads AI settings from request body, uses the same Anthropic client setup, returns JSON.

- [ ] **Step 1: Create the route file**

Create `app/api/group-arcs/route.ts` with the following:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { NarrativeArc, ParentArc } from '@/types';

const anthropic = new Anthropic();

const PARENT_ARC_SCHEMA = `{
  "parentArcs": [
    {
      "name": "Parent arc name",
      "children": ["child arc 1", "child arc 2"],
      "summary": "1-2 sentences about this thematic strand"
    }
  ]
}`;

function buildGroupArcsPrompt(
  bookTitle: string,
  bookAuthor: string,
  arcs: NarrativeArc[],
): string {
  const arcLines = arcs
    .map((a) => `- ${a.name} [${a.status}]: ${a.summary} (characters: ${a.characters.join(', ')})`)
    .join('\n');
  return `Given the following narrative arcs from "${bookTitle}" by ${bookAuthor}, group them into at most 5 high-level story threads (parent arcs). Each parent arc should represent a major thematic strand of the book.

ARCS:
${arcLines}

RULES:
- Create at most 5 parent arcs. Fewer is better if arcs naturally cluster.
- Every arc must belong to exactly one parent.
- Parent arc names should be concise and capture the shared theme.
- Order children within each parent by narrative importance.
- Write a 1-2 sentence summary for each parent arc describing its overarching theme.
- Use the EXACT arc names from the list above in the "children" arrays. Do not rename or paraphrase them.

Return ONLY a JSON object (no markdown fences, no explanation):
${PARENT_ARC_SCHEMA}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { bookTitle, bookAuthor, arcs, _provider, _apiKey, _model, _ollamaUrl } = body as {
      bookTitle: string;
      bookAuthor: string;
      arcs: NarrativeArc[];
      _provider?: string;
      _apiKey?: string;
      _model?: string;
      _ollamaUrl?: string;
    };

    if (!arcs?.length) {
      return NextResponse.json({ parentArcs: [] });
    }

    const prompt = buildGroupArcsPrompt(bookTitle, bookAuthor, arcs);
    const arcNames = new Set(arcs.map((a) => a.name));
    const arcNamesLower = new Map(arcs.map((a) => [a.name.toLowerCase(), a.name]));

    let text: string;

    if (_provider === 'ollama') {
      const ollamaUrl = _ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
      const model = _model || 'llama3';
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      const data = await res.json();
      text = data.response ?? '';
    } else {
      const apiKey = _apiKey || process.env.ANTHROPIC_API_KEY;
      const model = _model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
      const client = apiKey && apiKey !== process.env.ANTHROPIC_API_KEY
        ? new Anthropic({ apiKey })
        : anthropic;
      const msg = await client.messages.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });
      text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }

    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as { parentArcs: ParentArc[] };

    // Validate: resolve child names to exact arc names, drop unknown ones
    const assigned = new Set<string>();
    const validated: ParentArc[] = (parsed.parentArcs ?? []).map((pa) => {
      const resolvedChildren = pa.children
        .map((child) => arcNamesLower.get(child.toLowerCase()) ?? (arcNames.has(child) ? child : null))
        .filter((c): c is string => c !== null && !assigned.has(c));
      for (const c of resolvedChildren) assigned.add(c);
      return { name: pa.name, children: resolvedChildren, summary: pa.summary };
    }).filter((pa) => pa.children.length > 0);

    // Any unassigned arcs go to "Other"
    const unassigned = arcs.filter((a) => !assigned.has(a.name)).map((a) => a.name);
    if (unassigned.length > 0) {
      validated.push({ name: 'Other', children: unassigned, summary: 'Arcs not assigned to a thematic group.' });
    }

    return NextResponse.json({ parentArcs: validated });
  } catch (err) {
    console.error('[group-arcs] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to group arcs' },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add app/api/group-arcs/route.ts
git commit -m "feat: add group-arcs API route for parent arc generation"
```

---

### Task 3: Wire parent arc generation into analysis flows

**Files:**
- Modify: `app/page.tsx`

This task adds:
1. A client-side `generateParentArcs` function that calls the new API route
2. A shared `maybeGenerateParentArcs` helper that checks the trigger condition and calls the API
3. Calls to the helper at the end of `handleAnalyze`, `handleRebuild`, `handleProcessBook`, and the queue processor

- [ ] **Step 1: Add the generateParentArcs and maybeGenerateParentArcs helper functions**

Add these functions after the existing `reconcileResult` function (around line 270, before the component declaration). `generateParentArcs` follows the same pattern as `analyzeChapter` — loads AI settings, makes a fetch call, returns parsed data. `maybeGenerateParentArcs` encapsulates the trigger condition so it isn't duplicated across call sites:

```typescript
async function generateParentArcs(
  bookTitle: string,
  bookAuthor: string,
  arcs: NarrativeArc[],
): Promise<ParentArc[]> {
  if (!arcs?.length) return [];

  let aiSettings: Record<string, string> = {};
  try {
    const { loadAiSettings } = await import('@/lib/ai-client');
    const s = loadAiSettings();
    if (s.provider) aiSettings._provider = s.provider;
    if (s.anthropicKey) aiSettings._apiKey = s.anthropicKey;
    if (s.ollamaUrl) aiSettings._ollamaUrl = s.ollamaUrl;
    if (s.model) aiSettings._model = s.model;
  } catch { /* ignore */ }

  const res = await fetch('/api/group-arcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookTitle, bookAuthor, arcs, ...aiSettings }),
  });
  if (!res.ok) throw new Error('Failed to group arcs');
  const data = await res.json() as { parentArcs: ParentArc[] };
  return data.parentArcs;
}

/** Fire parent arc grouping if the book is fully analyzed. Returns the (possibly updated) stored state. */
async function maybeGenerateParentArcs(
  stored: StoredBookState,
  bookTitle: string,
  bookAuthor: string,
  rangeEnd: number,
  cancelled: boolean,
): Promise<StoredBookState> {
  if (cancelled) return stored;
  if (stored.lastAnalyzedIndex < rangeEnd) return stored;
  if (!stored.result.arcs?.length) return stored;
  try {
    const parentArcs = await generateParentArcs(bookTitle, bookAuthor, stored.result.arcs);
    return { ...stored, parentArcs };
  } catch (e) {
    console.warn('[parent-arcs] Generation failed:', e);
    return stored;
  }
}
```

- [ ] **Step 2: Add parent arc trigger to handleAnalyze**

In `handleAnalyze`, after the analysis loop completes (after line 909, the last `}` of the for-loop body, before the `} catch` on line 910). Insert:

```typescript
      // Generate parent arcs if all chapters in range are now analyzed
      const rEnd = chapterRange?.end ?? (book.chapters.length - 1);
      const withParents = await maybeGenerateParentArcs(storedRef.current!, book.title, book.author, rEnd, analyzeCancelRef.current);
      storedRef.current = withParents;
      saveStored(book.title, book.author, withParents);
```

- [ ] **Step 3: Add parent arc trigger to handleRebuild**

Same pattern, at the end of the try block in `handleRebuild` (after line 948, before the `} catch` on line 950):

```typescript
      const rEnd = chapterRange?.end ?? (book.chapters.length - 1);
      const withParents = await maybeGenerateParentArcs(storedRef.current!, book.title, book.author, rEnd, rebuildCancelRef.current);
      storedRef.current = withParents;
      saveStored(book.title, book.author, withParents);
```

- [ ] **Step 4: Add parent arc trigger to handleProcessBook**

Same pattern, at the end of the try block in `handleProcessBook` (after line 990, before the `} catch` on line 992). Note: `handleProcessBook` also uses `rebuildCancelRef` for cancellation (they share the same ref):

```typescript
      const rEnd = chapterRange?.end ?? (book.chapters.length - 1);
      const withParents = await maybeGenerateParentArcs(storedRef.current!, book.title, book.author, rEnd, rebuildCancelRef.current);
      storedRef.current = withParents;
      saveStored(book.title, book.author, withParents);
```

- [ ] **Step 5: Add parent arc trigger to queue processor**

In the queue processor `useEffect` (the `run()` function), after the final reconciliation block (after line 663 `}`), before marking the job as done (line 665 `setQueue`). The queue processor doesn't have a `chapterRange` — it always processes all chapters, so `rangeEnd = toIndex`:

```typescript
        // Generate parent arcs after full book processing
        if (accumulated?.arcs?.length) {
          try {
            const parentArcs = await generateParentArcs(title, author, accumulated.arcs);
            latestStored = { ...latestStored, parentArcs };
            saveStored(title, author, latestStored);
            if (bookRef.current?.title === title && bookRef.current?.author === author) {
              storedRef.current = latestStored;
            }
          } catch (e) { console.warn('[parent-arcs] Queue generation failed:', e); }
        }
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx
git commit -m "feat: trigger parent arc generation after full book analysis"
```

---

### Task 4: Wire parentArcs invalidation into applyResultEdit

**Files:**
- Modify: `app/page.tsx:504-544` (applyResultEdit function)

When arcs are edited (rename, merge, split, delete) via NarrativeArcModal, the `applyResultEdit` callback runs with the updated result and an optional `SnapshotTransform`. We need to update `parentArcs` to reflect the arc changes.

- [ ] **Step 1: Add parentArcs sync to applyResultEdit**

In `applyResultEdit` (line 504), after the line that updates `storedRef.current` (line 520: `storedRef.current = updated;`), add parent arc synchronization. The approach: compare the old arc names with the new arc names and update `parentArcs.children` accordingly.

After line 521 (`saveStored(book.title, book.author, updated);`), insert:

```typescript
      // Sync parentArcs with arc edits (rename, delete, merge, split)
      if (updated.parentArcs?.length) {
        const oldArcNames = new Set((cur.result.arcs ?? []).map((a) => a.name));
        const newArcNames = new Set((newResult.arcs ?? []).map((a) => a.name));
        const removed = [...oldArcNames].filter((n) => !newArcNames.has(n));
        const added = [...newArcNames].filter((n) => !oldArcNames.has(n));

        let parentArcs: ParentArc[];

        if (removed.length === 1 && added.length === 1) {
          // Rename: replace old child name with new name in-place
          parentArcs = updated.parentArcs.map((pa) => ({
            ...pa,
            children: pa.children.map((c) => c === removed[0] ? added[0] : c),
          }));
        } else {
          // Delete/merge: remove old names from children
          parentArcs = updated.parentArcs.map((pa) => ({
            ...pa,
            children: pa.children.filter((c) => !removed.includes(c)),
          }));
          // Split: original stays, new arc added to same parent
          if (added.length > 0 && removed.length === 0) {
            const newArcs = (newResult.arcs ?? []).filter((a) => added.includes(a.name));
            for (const na of newArcs) {
              const placed = parentArcs.find((pa) =>
                pa.children.some((c) => {
                  const existing = (newResult.arcs ?? []).find((a) => a.name === c);
                  return existing?.characters.some((ch) => na.characters.includes(ch));
                })
              );
              if (placed) placed.children.push(na.name);
              else parentArcs[parentArcs.length - 1]?.children.push(na.name);
            }
          }
        }
        // Remove empty parents
        parentArcs = parentArcs.filter((pa) => pa.children.length > 0);
        const synced = { ...updated, parentArcs: parentArcs.length > 0 ? parentArcs : undefined };
        storedRef.current = synced;
        saveStored(book.title, book.author, synced);
      }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: sync parentArcs when arcs are edited via modal"
```

---

### Task 5: Add collapsible grouped view to ArcsPanel

**Files:**
- Modify: `components/ArcsPanel.tsx`

This is the main UI task. When `parentArcs` is provided, render arcs grouped under collapsible parent sections. When not provided, render the existing flat list unchanged.

- [ ] **Step 1: Update Props interface and imports**

Add `ParentArc` to the import from `@/types` (line 4):

```typescript
import type { AnalysisResult, NarrativeArc, ParentArc, Snapshot } from '@/types';
```

Add to the Props interface (after line 17):

```typescript
  parentArcs?: ParentArc[];
  onUpdateParentArcs?: (parentArcs: ParentArc[]) => void;
```

Add to the component destructuring (line 26):

```typescript
export default function ArcsPanel({ arcs, snapshots, chapterTitles, currentResult, onResultEdit, arcChapterMap: arcChapterMapProp, currentChapterIndex, parentArcs, onUpdateParentArcs }: Props) {
```

- [ ] **Step 2: Add collapsed state and inline edit state**

Add `useEffect` to the import from `react` (line 3):

```typescript
import { useEffect, useState } from 'react';
```

After the existing `useState` declarations (line 29), add:

```typescript
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(parentArcs?.map((pa) => pa.name) ?? []));
  const [editingGroupName, setEditingGroupName] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');
  const [moveArc, setMoveArc] = useState<string | null>(null);
```

The `useState` initializer only runs once, so if `parentArcs` arrives later (e.g., after the AI call completes), the groups wouldn't be collapsed. Add a `useEffect` to handle this:

```typescript
  useEffect(() => {
    if (parentArcs?.length) {
      setCollapsedGroups((prev) => {
        if (prev.size === 0) return new Set(parentArcs.map((pa) => pa.name));
        return prev;
      });
    }
  }, [parentArcs]);
```

- [ ] **Step 3: Add helper to render a single arc card**

Extract the existing arc card JSX (lines 117-189, the `<button>` element) into a helper function inside the component, so both the flat and grouped views can reuse it. Place it after the `arcChapterMap` computation (after line 65):

```typescript
  function renderArcCard(arc: NarrativeArc, showMoveAction = false) {
    const cfg = STATUS_CONFIG[arc.status];
    const chapters = arcChapterMap.get(arc.name) ?? [];
    const firstCh = chapters[0] ?? null;
    const lastCh = chapters[chapters.length - 1] ?? null;

    return (
      <div key={arc.name} className="relative group">
        <button
          onClick={() => setSelectedArc(arc.name)}
          className="w-full text-left rounded-xl border border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3 hover:border-stone-300 dark:hover:border-zinc-700 hover:shadow-sm transition-all cursor-pointer"
        >
          {/* Header row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${cfg.dot} ${arc.status === 'active' ? 'animate-pulse' : ''}`} />
              <h3 className="font-semibold text-stone-800 dark:text-zinc-100 text-sm leading-snug">{arc.name}</h3>
            </div>
            <span className={`flex-shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cfg.badge}`}>
              {cfg.label}
            </span>
          </div>

          {/* Summary */}
          <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">{arc.summary}</p>

          {/* Characters involved */}
          {arc.characters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {arc.characters.map((name) => (
                <span
                  key={name}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); handleEntityClick('character', name); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleEntityClick('character', name); } }}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 border border-stone-200 dark:border-zinc-700 hover:underline cursor-pointer"
                >
                  {name}
                </span>
              ))}
            </div>
          )}

          {/* Chapter span bar */}
          {chapters.length > 0 && totalChapters > 1 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-stone-400 dark:text-zinc-600">
                <span>{firstCh !== null ? (chapterTitles[firstCh] ?? `Ch. ${firstCh + 1}`) : '—'}</span>
                {lastCh !== firstCh && lastCh !== null && (
                  <span>{chapterTitles[lastCh] ?? `Ch. ${lastCh + 1}`}</span>
                )}
              </div>
              <div className="w-full h-1.5 bg-stone-100 dark:bg-zinc-800 rounded-full overflow-hidden relative">
                <div
                  className={`absolute top-0 h-full rounded-full ${cfg.dot} opacity-60`}
                  style={{
                    left: `${((firstCh ?? 0) / totalChapters) * 100}%`,
                    width: `${Math.max(2, (((lastCh ?? firstCh ?? 0) - (firstCh ?? 0) + 1) / totalChapters) * 100)}%`,
                  }}
                />
                {chapters.map((idx) => (
                  <div
                    key={idx}
                    className={`absolute top-0 w-0.5 h-full ${cfg.dot}`}
                    style={{ left: `${((idx + 0.5) / totalChapters) * 100}%` }}
                    title={chapterTitles[idx] ?? `Ch. ${idx + 1}`}
                  />
                ))}
              </div>
            </div>
          )}
        </button>

        {/* Move action (shown in grouped view) */}
        {showMoveAction && parentArcs && parentArcs.length > 1 && (
          <div className="absolute top-3 right-12 z-10">
            <button
              onClick={(e) => { e.stopPropagation(); setMoveArc(moveArc === arc.name ? null : arc.name); }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded text-stone-400 hover:text-stone-600 dark:text-zinc-600 dark:hover:text-zinc-400 transition-all"
              title="Move to another group"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 9l4-4 4 4" /><path d="M9 5v12" /><path d="M15 19l4-4-4-4" /><path d="M19 15H7" />
              </svg>
            </button>
            {moveArc === arc.name && (
              <div className="absolute top-8 right-0 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[160px] z-20">
                {parentArcs.filter((pa) => !pa.children.includes(arc.name)).map((pa) => (
                  <button
                    key={pa.name}
                    onClick={(e) => { e.stopPropagation(); handleMoveArc(arc.name, pa.name); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800"
                  >
                    {pa.name}
                  </button>
                ))}
                <button
                  onClick={(e) => { e.stopPropagation(); handleMoveArcToNew(arc.name); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-amber-500 hover:bg-stone-100 dark:hover:bg-zinc-800 border-t border-stone-100 dark:border-zinc-800"
                >
                  + New group...
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
```

- [ ] **Step 4: Add move/rename handler functions**

After the `renderArcCard` function, add:

```typescript
  function handleMoveArc(arcName: string, targetParent: string) {
    if (!parentArcs || !onUpdateParentArcs) return;
    const updated = parentArcs.map((pa) => ({
      ...pa,
      children: pa.children.includes(arcName)
        ? pa.children.filter((c) => c !== arcName)
        : pa.name === targetParent
          ? [...pa.children, arcName]
          : pa.children,
    })).filter((pa) => pa.children.length > 0);
    onUpdateParentArcs(updated);
    setMoveArc(null);
  }

  function handleMoveArcToNew(arcName: string) {
    if (!parentArcs || !onUpdateParentArcs) return;
    const newName = prompt('New group name:');
    if (!newName?.trim()) { setMoveArc(null); return; }
    const updated = parentArcs.map((pa) => ({
      ...pa,
      children: pa.children.filter((c) => c !== arcName),
    })).filter((pa) => pa.children.length > 0);
    updated.push({ name: newName.trim(), children: [arcName], summary: '' });
    onUpdateParentArcs(updated);
    setMoveArc(null);
  }

  function handleRenameGroup(oldName: string, newName: string) {
    if (!parentArcs || !onUpdateParentArcs || !newName.trim()) return;
    const updated = parentArcs.map((pa) =>
      pa.name === oldName ? { ...pa, name: newName.trim() } : pa
    );
    onUpdateParentArcs(updated);
    setEditingGroupName(null);
  }
```

- [ ] **Step 5: Update the return JSX to render grouped view when parentArcs exist**

Replace the existing arc card rendering block (lines 110-192, the `<div className="space-y-4">` through to `</div>` before `</>`). The new JSX renders either the grouped view or the flat view:

```typescript
    <div className="space-y-4">
      {parentArcs?.length ? (
        // Grouped view
        (() => {
          const statusOrder = { active: 0, dormant: 1, resolved: 2 };
          const arcMap = new Map(arcs.map((a) => [a.name, a]));
          const sortedParents = [...parentArcs].sort((a, b) => {
            const aStatus = Math.min(...a.children.map((c) => statusOrder[arcMap.get(c)?.status ?? 'resolved'] ?? 2));
            const bStatus = Math.min(...b.children.map((c) => statusOrder[arcMap.get(c)?.status ?? 'resolved'] ?? 2));
            return aStatus !== bStatus ? aStatus - bStatus : b.children.length - a.children.length;
          });
          return sortedParents.map((pa) => {
            const isCollapsed = collapsedGroups.has(pa.name);
            const childArcs = pa.children.map((c) => arcMap.get(c)).filter((a): a is NarrativeArc => !!a);
            const bestStatus = childArcs.reduce<NarrativeArc['status']>((best, a) =>
              statusOrder[a.status] < statusOrder[best] ? a.status : best, 'resolved');
            const cfg = STATUS_CONFIG[bestStatus];

            return (
              <div key={pa.name} className="rounded-xl border border-stone-200 dark:border-zinc-800 overflow-hidden">
                {/* Parent header */}
                <button
                  onClick={() => setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    next.has(pa.name) ? next.delete(pa.name) : next.add(pa.name);
                    return next;
                  })}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 bg-stone-50 dark:bg-zinc-900/50 hover:bg-stone-100 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <svg
                    width="12" height="12" viewBox="0 0 12 12" fill="currentColor"
                    className={`text-stone-400 dark:text-zinc-600 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  >
                    <path d="M4 2l4 4-4 4" />
                  </svg>
                  <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                  {editingGroupName === pa.name ? (
                    <input
                      autoFocus
                      className="text-sm font-semibold bg-transparent border-b border-amber-500 outline-none text-stone-800 dark:text-zinc-100"
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      onBlur={() => handleRenameGroup(pa.name, editNameValue)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameGroup(pa.name, editNameValue); if (e.key === 'Escape') setEditingGroupName(null); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="text-sm font-semibold text-stone-800 dark:text-zinc-100 cursor-text"
                      onDoubleClick={(e) => { e.stopPropagation(); setEditingGroupName(pa.name); setEditNameValue(pa.name); }}
                    >
                      {pa.name}
                    </span>
                  )}
                  <span className="text-[11px] text-stone-400 dark:text-zinc-600">
                    {childArcs.length} arc{childArcs.length !== 1 ? 's' : ''}
                  </span>
                  {isCollapsed && pa.summary && (
                    <span className="ml-auto text-xs text-stone-400 dark:text-zinc-600 truncate max-w-[200px]">{pa.summary}</span>
                  )}
                </button>

                {/* Expanded children */}
                {!isCollapsed && (
                  <div className="p-3 space-y-3 bg-white dark:bg-zinc-900">
                    {pa.summary && (
                      <p className="text-xs text-stone-400 dark:text-zinc-500 leading-relaxed px-1">{pa.summary}</p>
                    )}
                    {childArcs.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]).map((arc) => renderArcCard(arc, true))}
                  </div>
                )}
              </div>
            );
          });
        })()
      ) : (
        // Flat view (no parent arcs)
        sorted.map((arc) => renderArcCard(arc))
      )}
    </div>
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Verify build succeeds**

Run: `npm run build`
Expected: Build completes successfully

- [ ] **Step 8: Commit**

```bash
git add components/ArcsPanel.tsx
git commit -m "feat: add collapsible grouped view and inline editing to ArcsPanel"
```

---

### Task 6: Pass parentArcs from page.tsx to ArcsPanel and MapBoard

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add handleUpdateParentArcs handler**

Add this function near the other handlers in `page.tsx` (after `handleSetBookmark`, around line 420):

```typescript
  function handleUpdateParentArcs(parentArcs: ParentArc[]) {
    if (!book || !storedRef.current) return;
    const updated = { ...storedRef.current, parentArcs: parentArcs.length > 0 ? parentArcs : undefined };
    storedRef.current = updated;
    saveStored(book.title, book.author, updated);
  }
```

- [ ] **Step 2: Pass parentArcs to ArcsPanel**

Find the `<ArcsPanel` JSX (around line 1801). Add the new props:

```typescript
                    <ArcsPanel
                      arcs={result.arcs ?? []}
                      snapshots={stored?.snapshots ?? []}
                      chapterTitles={book.chapters.map((ch) => ch.title)}
                      currentResult={result}
                      onResultEdit={applyResultEdit}
                      arcChapterMap={derived.arcChapterMap}
                      currentChapterIndex={currentChapterIndex}
                      parentArcs={stored?.parentArcs}
                      onUpdateParentArcs={handleUpdateParentArcs}
                    />
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: pass parentArcs to ArcsPanel and MapBoard"
```

---

### Task 7: Thread parentArcs through MapBoard to SubwayMap

**Files:**
- Modify: `app/page.tsx` (MapBoard call, around line 1635)
- Modify: `components/MapBoard.tsx:12-26` (Props interface)
- Modify: `components/MapBoard.tsx:479` (SubwayMap call)
- Modify: `components/SubwayMap.tsx:492-501` (Props interface)
- Modify: `components/SubwayMap.tsx:149-250` (buildGraph arc lane logic)

- [ ] **Step 1: Add parentArcs to MapBoard Props and pass from page.tsx**

In `components/MapBoard.tsx`, add to the Props interface (after `currentChapterIndex` on line 25):

```typescript
  parentArcs?: ParentArc[];
```

Add `ParentArc` to the import from `@/types` (line 4):

```typescript
import type { AnalysisResult, Character, LocationInfo, LocationPin, MapState, NarrativeArc, ParentArc, PinUpdates, Snapshot } from '@/types';
```

Add `parentArcs` to the component destructuring. Find the line where the component is defined and add `parentArcs` to the destructured props.

In `app/page.tsx`, find the `<MapBoard` JSX (around line 1635) and add the `parentArcs` prop:

```typescript
                  parentArcs={stored?.parentArcs}
```

Add it after the `currentChapterIndex` prop, before `onMapStateChange`.

- [ ] **Step 2: Pass parentArcs to SubwayMap**

Find the SubwayMap call (line 479) and add the prop:

```typescript
          <SubwayMap snapshots={...} currentCharacters={displayedChars} currentLocations={currentResult?.locations} locationMergeMap={...} locationAliasMap={aliasMapProp} onCharacterClick={setSelectedCharName} onLocationClick={setSelectedLocationName} onArcClick={setSelectedArcName} parentArcs={parentArcs} />
```

- [ ] **Step 3: Add parentArcs to SubwayMap Props**

In `components/SubwayMap.tsx`, add `ParentArc` to the import from `@/types` (line 2):

```typescript
import type { Character, LocationInfo, ParentArc, Snapshot } from '@/types';
```

Add to the Props interface (after `onArcClick` on line 500):

```typescript
  parentArcs?: ParentArc[];
```

Add `parentArcs` to the component destructuring on line 503.

- [ ] **Step 4: Update buildGraph to accept and use parentArcs for lane assignment**

Add `parentArcs` parameter to `buildGraph` signature (line 149):

```typescript
function buildGraph(snapshots: Snapshot[], locationMergeMap?: Map<string, string>, currentLocations?: LocationInfo[], prebuiltAliasMap?: Map<string, string>, parentArcs?: ParentArc[]): { ... }
```

In the arc lane building section (lines 228-250), after building `locArc` (which maps location name → arc string from `LocationInfo.arc`), add parent arc resolution. Replace lines 228-250 with:

```typescript
  // Build arc lanes — use parent arcs if available
  if (parentArcs?.length) {
    // Build case-insensitive child→parent lookup
    const childToParent = new Map<string, string>();
    for (const pa of parentArcs) {
      for (const child of pa.children) childToParent.set(child.toLowerCase(), pa.name);
    }

    // Remap locArc values to parent arc names
    const parentLocArc = new Map<string, string>();
    for (const [loc, arcName] of locArc) {
      const parentName = childToParent.get(arcName.toLowerCase());
      if (parentName) parentLocArc.set(loc, parentName);
      else parentLocArc.set(loc, arcName); // ungrouped arc keeps its name
    }

    // Replace locArc with parent-resolved version for lane assignment
    locArc.clear();
    for (const [k, v] of parentLocArc) locArc.set(k, v);
  }

  // Build arc lanes sorted by earliest first-appearance among each arc's locations
  const arcFirstChapter = new Map<string, number>();
  for (const [loc, arc] of locArc) {
    const ch = locFirstChapter.get(loc) ?? 0;
    const prev = arcFirstChapter.get(arc);
    if (prev === undefined || ch < prev) arcFirstChapter.set(arc, ch);
  }
  const namedArcs = [...arcFirstChapter.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([arc]) => arc);
  const hasUnlabelled = [...nodeIds].some((id) => !locArc.has(id));
  const allArcNames = hasUnlabelled ? [...namedArcs, ''] : namedArcs;
  const totalLanes = Math.max(allArcNames.length, 1);
  const laneH = (H - LANE_MARGIN_TOP - LANE_MARGIN_BOT) / totalLanes;

  const arcLanes: ArcLane[] = allArcNames.map((name, i) => ({
    name,
    label: name || 'Other',
    y: LANE_MARGIN_TOP + laneH * i + laneH / 2,
    height: laneH,
  }));
  const laneByArc = new Map(arcLanes.map((l) => [l.name, l]));
```

Note: `locArc` is declared as `const` on line 165 but `Map.clear()` and `Map.set()` are mutation methods, so `const` is fine. The mutated `locArc` is used later for node → lane assignment (line 256: `const arc = locArc.get(id) ?? ''`), so nodes will automatically be assigned to the correct parent lane.

- [ ] **Step 5: Pass parentArcs to buildGraph calls**

SubwayMap calls `buildGraph` in two places — a `useState` initializer (line 516) and a `useEffect` (line 536-539). Update both:

The `useState` initializer (line 516):

```typescript
const [graph, setGraph] = useState<...>(() => buildGraph(snapshots, locationMergeMap, currentLocations, aliasMapProp, parentArcs));
```

The `useEffect` (line 536-539) — add `parentArcs` to both the call and the dependency array:

```typescript
  useEffect(() => {
    setGraph(buildGraph(snapshots, locationMergeMap, currentLocations, aliasMapProp, parentArcs));
    setSettled(false);
  }, [snapshots, locationMergeMap, currentLocations, aliasMapProp, parentArcs]);
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Verify build succeeds**

Run: `npm run build`
Expected: Build completes successfully

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx components/MapBoard.tsx components/SubwayMap.tsx
git commit -m "feat: consolidate SubwayMap lanes to parent arcs when available"
```
