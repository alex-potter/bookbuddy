# Parent Story Arcs: Automatic Arc Grouping

## Problem

After a book is fully analyzed, a book may have many narrative arcs (3-7+). There is no high-level overview that groups related arcs into a small number of thematic storylines. Users must read through every arc to understand the book's structure.

## Solution

After the last chapter's analysis completes, automatically fire an AI call that groups all existing arcs into a maximum of 5 **parent arcs**. Each parent arc has a name, a summary, and an ordered list of child arcs. The parent arcs appear as collapsible section headers in the ArcsPanel, and SubwayMap lanes consolidate to match the parent arcs. Users can manually modify groupings after the fact.

## Data Model

Add `ParentArc` type to `types/index.ts`:

```typescript
interface ParentArc {
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

The parent arc grouping call fires automatically at the end of `handleAnalyze` in `page.tsx`, after the analysis loop completes, when the final analyzed chapter is the last chapter in the book (or the last chapter in the configured range).

Condition: the analysis loop completed without cancellation, and `lastAnalyzedIndex` equals the range end index.

### API Endpoint

Add a new function in `app/api/analyze/route.ts` that handles parent arc grouping. This reuses the existing API route and model selection infrastructure.

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

- Parse the JSON response, validate that all child names match existing arc names.
- Any arcs not assigned by the AI get placed in a catch-all "Other" parent.
- Any child names that don't match existing arcs are silently dropped.
- Save `parentArcs` to `StoredBookState` via `saveStored()`.

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

- Build a lookup map: child arc name → parent arc name.
- In `buildGraph()`, when assigning locations to arc lanes, use the parent arc name instead of the individual arc name.
- This consolidates lanes from many individual arcs down to ≤5 parent arc lanes.
- Lane labels show the parent arc name.
- The "Other" lane catches locations whose arc is not in any parent group.

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
| `app/page.tsx` | Add `parentArcs` to `StoredBookState`, trigger AI call after full analysis, add `handleUpdateParentArcs` handler, pass `parentArcs` to ArcsPanel and MapBoard |
| `app/api/analyze/route.ts` | Add parent arc grouping prompt builder and action handler |
| `components/ArcsPanel.tsx` | Accept `parentArcs` and `onUpdateParentArcs` props, render collapsible grouped view with inline edit controls |
| `components/MapBoard.tsx` | Pass `parentArcs` through to SubwayMap |
| `components/SubwayMap.tsx` | Accept `parentArcs` prop, use parent arc names for lane assignment when available |

## Invalidation

When a user edits arcs through NarrativeArcModal (merge, split, delete, rename), the parent arc groupings may become stale:

- **Arc renamed:** Update the child name reference in `parentArcs` (handled in page.tsx alongside the existing rename propagation).
- **Arc deleted:** Remove the deleted arc name from its parent's `children` array. If the parent becomes empty, remove it.
- **Arc merged:** The absorbed arc is removed from its parent's children; the primary arc remains.
- **Arc split:** The original arc name stays in its parent; the new arc is added to the same parent's children.

This keeps parent arcs consistent without requiring regeneration on every edit.

## Edge Cases

- **Fewer than 3 arcs:** Still group (may produce 1-2 parent arcs). The AI handles this naturally.
- **Re-analysis after grouping:** If the user re-analyzes chapters or analyzes additional chapters, and the book is again fully analyzed at the end, the parent arc call fires again, overwriting previous groupings.
- **Cancelled analysis:** Parent arc call does not fire if analysis was cancelled before reaching the final chapter.
- **Series continuation:** `parentArcs` resets to `undefined` when carrying state forward to a new book (same as `readingBookmark`).
- **Background queue processing:** The queue processor (`handleProcessBook`) should also trigger parent arc grouping when it completes a full book analysis.
- **No arcs in result:** If `result.arcs` is empty or undefined, skip the parent arc call entirely.

## Scope Exclusions

- **Reading bookmark interaction:** Parent arcs are a book-level grouping, independent of the reading bookmark. All parent arcs are visible regardless of bookmark position. (Individual child arcs within the ArcsPanel are still subject to existing chapter filtering via `currentChapterIndex`.)
- **Chat/share context:** Parent arcs are not included in chat or share context. These use the flat arc data as today.
- **Arc creation in modal:** Users cannot create new child arcs through the parent arc UI. Arc creation remains through the existing analysis flow.
