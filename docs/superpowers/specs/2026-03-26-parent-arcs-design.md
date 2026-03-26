# Parent Story Arcs: Automatic Arc Grouping

## Problem

After a book is fully analyzed, a book may have many narrative arcs (3-7+). There is no high-level overview that groups related arcs into a small number of thematic storylines. Users must read through every arc to understand the book's structure.

## Solution

After the last chapter's analysis completes, automatically fire an AI call that groups all existing arcs into a maximum of 5 **parent arcs**. Each parent arc has a name, a summary, and an ordered list of child arcs. The parent arcs appear as collapsible section headers in the ArcsPanel, and SubwayMap lanes consolidate to match the parent arcs. Users can manually modify groupings after the fact.

## Data Model

Add `ParentArc` type to `types/index.ts`:

```typescript
export interface ParentArc {
  name: string;
  children: string[];  // child arc names, ordered
  summary: string;     // AI-generated summary of the grouped theme
}
```

Add `parentArcs?: ParentArc[]` to `StoredBookState` in `app/page.tsx`:

```typescript
interface StoredBookState {
  // ... existing fields unchanged
  parentArcs?: ParentArc[];
}
```

**Default behavior:** When `parentArcs` is `undefined` (legacy data, mid-analysis), ArcsPanel renders the existing flat list. SubwayMap uses individual arc lanes as today.

## AI Call

### Trigger

The parent arc grouping call fires automatically after any analysis flow completes the full book. There are three analysis flows in `page.tsx` that can trigger it:

1. **`handleAnalyze`** — the primary "Analyze" button flow
2. **`handleRebuild`** — the "Rebuild" flow that re-analyzes from scratch
3. **Queue processor `useEffect`** — background queue processing for batched books

**Condition:** The analysis loop completed without cancellation, and all analyzable chapters in the configured range have been analyzed (i.e., `lastAnalyzedIndex >= rangeEnd`).

To avoid duplication, extract a shared helper:

```typescript
async function maybeGenerateParentArcs(stored: StoredBookState, bookTitle: string, bookAuthor: string) {
  const rangeEnd = stored.chapterRange?.end ?? /* total chapters - 1 */;
  if (stored.lastAnalyzedIndex < rangeEnd) return;
  if (!stored.result.arcs?.length) return;
  // fire the API call, save parentArcs
}
```

Called at the end of each analysis flow's success path.

### API Endpoint

Create a new API route at `app/api/group-arcs/route.ts`. This has a completely different input/output shape from the chapter analysis route and deserves its own endpoint. It reuses the same model selection infrastructure (reads the user's preferred model from the request).

Request body:

```typescript
{
  bookTitle: string;
  bookAuthor: string;
  arcs: NarrativeArc[];
  model?: string;
}
```

Response body:

```typescript
{
  parentArcs: ParentArc[];
}
```

### Prompt

Input: all current arcs (name, status, characters, summary).

```
Given the following narrative arcs from "{bookTitle}" by {bookAuthor}, group them into
at most 5 high-level story threads (parent arcs). Each parent arc should represent a
major thematic strand of the book.

ARCS:
{arcLines}

RULES:
- Create at most 5 parent arcs. Fewer is better if arcs naturally cluster.
- Every arc must belong to exactly one parent.
- Parent arc names should be concise and capture the shared theme.
- Order children within each parent by narrative importance.
- Write a 1-2 sentence summary for each parent arc describing its overarching theme.

Return ONLY a JSON object (no markdown fences, no explanation):
{
  "parentArcs": [
    {
      "name": "Parent arc name",
      "children": ["child arc 1", "child arc 2"],
      "summary": "1-2 sentences about this thematic strand"
    }
  ]
}
```

### Response Handling

- Parse the JSON response, validate that all child names match existing arc names (case-insensitive match, using the closest match from the actual arc list).
- Any arcs not assigned by the AI get placed in a catch-all "Other" parent.
- Any child names that don't match existing arcs are silently dropped.
- Save `parentArcs` to `StoredBookState` via `saveStored()`.

### Loading and Error States

- While the parent arc call is in progress, show a subtle "Grouping arcs..." indicator in the ArcsPanel (inline, not blocking). The panel remains usable with the flat list during this time.
- If the call fails (network error, malformed response), fail silently — `parentArcs` stays `undefined` and the flat list remains. No retry button; the user can trigger re-analysis to try again, or future re-analysis will attempt grouping again.

## ArcsPanel Changes

### With parentArcs

Render arcs grouped under collapsible parent sections:

- **Section header:** Parent arc name, child count badge, combined status indicator (shows the "highest priority" status among children: active > dormant > resolved), expand/collapse toggle.
- **Default state:** All sections collapsed, showing parent name + child count + summary preview.
- **Expanded:** Child arc cards render exactly as today (same card layout, click to open modal, character chips, chapter span bar).
- **Sort order:** Parent sections sorted by highest-priority child status (sections with active children first), then by child count descending.

### Without parentArcs

Renders the existing flat list unchanged.

### Props Changes

Add to ArcsPanel Props:

```typescript
parentArcs?: ParentArc[];
onUpdateParentArcs?: (parentArcs: ParentArc[]) => void;
```

## Manual Grouping Edits

All modifications are inline in the ArcsPanel, no modal needed:

- **Rename parent arc:** Click the parent name text to edit inline. On blur/enter, save.
- **Reassign child arc:** Each child arc card shows a "move" icon on hover (consistent with existing hover-action patterns). Clicking opens a small dropdown listing other parent arcs + "New group..." option. Selecting moves the arc.
- **Create new parent:** Via the "New group..." option in the move dropdown. Prompts for a name inline.
- **Delete empty parent:** When the last child is moved out, the empty parent is automatically removed from the array.

All changes persist immediately via `onUpdateParentArcs` callback, which calls `saveStored()` in page.tsx.

## SubwayMap Changes

### With parentArcs

- Build a case-insensitive lookup map: child arc name → parent arc name. This maps `NarrativeArc.name` values to their parent.
- In `buildGraph()`, when assigning locations to arc lanes: the location's `LocationInfo.arc` string (a free-text field set by the AI) may not exactly match a `NarrativeArc.name`. Use case-insensitive matching to find the `NarrativeArc.name`, then look up that name in the parent arc map.
- This consolidates lanes from many individual arcs down to ≤5 parent arc lanes.
- Lane labels show the parent arc name.
- The "Other" lane catches locations whose arc cannot be resolved to any parent group.

### Without parentArcs

Current behavior — individual arc lanes.

### Props Changes

Add to SubwayMap Props:

```typescript
parentArcs?: ParentArc[];
```

Passed from MapBoard, which receives it from page.tsx.

## Files to Modify

| File | Change |
|------|--------|
| `types/index.ts` | Add `ParentArc` interface |
| `app/page.tsx` | Add `parentArcs` to `StoredBookState`, add `maybeGenerateParentArcs` helper called from all three analysis flows, add `handleUpdateParentArcs` handler, pass `parentArcs` to ArcsPanel and MapBoard, wire invalidation into `applyResultEdit` |
| `app/api/group-arcs/route.ts` | New route: parent arc grouping prompt builder and handler |
| `components/ArcsPanel.tsx` | Accept `parentArcs` and `onUpdateParentArcs` props, render collapsible grouped view with inline edit controls |
| `components/MapBoard.tsx` | Accept and pass `parentArcs` through to SubwayMap |
| `components/SubwayMap.tsx` | Accept `parentArcs` prop, use parent arc names for lane assignment when available |

## Invalidation

When a user edits arcs through NarrativeArcModal (merge, split, delete, rename), the `parentArcs` must be updated to stay consistent. This logic lives in `page.tsx`, wired into `applyResultEdit` (which already handles `SnapshotTransform` propagation for arc edits):

- **Arc renamed:** Update the child name reference in `parentArcs` — find the old name in all `children` arrays and replace with the new name.
- **Arc deleted:** Remove the deleted arc name from its parent's `children` array. If the parent becomes empty, remove the parent.
- **Arc merged:** The absorbed arc is removed from its parent's children; the primary arc remains in its parent.
- **Arc split:** The original arc name stays in its parent; the new arc is added to the same parent's `children` array.

This keeps parent arcs consistent without requiring regeneration on every edit.

## Edge Cases

- **Fewer than 3 arcs:** Still group (may produce 1-2 parent arcs). The AI handles this naturally.
- **Re-analysis after grouping:** If the user re-analyzes and the book is again fully analyzed, the parent arc call fires again, overwriting previous groupings (including any manual edits).
- **Cancelled analysis:** Parent arc call does not fire if analysis was cancelled before reaching the final chapter.
- **Series continuation:** `parentArcs` resets to `undefined` when carrying state forward to a new book (same as `readingBookmark`).
- **No arcs in result:** If `result.arcs` is empty or undefined, skip the parent arc call entirely.
- **Export/import compatibility:** `parentArcs` is an optional field on `StoredBookState`. Importing data without it shows the flat list. Importing data with it into an older app version has no effect (unknown fields are ignored by the spread).

## Scope Exclusions

- **Reading bookmark interaction:** Parent arcs are a book-level grouping, independent of the reading bookmark. All parent arcs are visible regardless of bookmark position. (Individual child arcs within the ArcsPanel are still subject to existing chapter filtering via `currentChapterIndex`.)
- **Chat/share context:** Parent arcs are not included in chat or share context. These use the flat arc data as today.
- **Arc creation in modal:** Users cannot create new child arcs through the parent arc UI. Arc creation remains through the existing analysis flow.
