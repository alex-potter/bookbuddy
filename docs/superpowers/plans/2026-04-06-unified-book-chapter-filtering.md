# Unified Book/Chapter Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual-layer filtering system (`seriesHiddenChapters` + `filteredSnapshots`) with a single `visibleChapterOrders` set that hides excluded books/chapters everywhere and propagates the active book filter to all consumers.

**Architecture:** A single `useMemo` in `page.tsx` computes `visibleChapterOrders: Set<number> | null` from the series definition and active book filter. A derived `visibleSnapshots` array filters snapshots against this set. All downstream consumers (sidebar, timeline, panels) receive the filtered data. An auto-navigate effect handles jumping when the current position falls outside the visible set.

**Tech Stack:** React (Next.js), TypeScript

**Spec:** `docs/superpowers/specs/2026-04-06-unified-book-chapter-filtering-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `app/page.tsx` | Modify | Replace `seriesHiddenChapters` + `filteredSnapshots` with `visibleChapterOrders` + `visibleSnapshots`; add auto-navigate effect; update all consumer props; remove legacy `excludedBooks`/`excludedChapters` state and `toggleBook`/`toggleChapter` |
| `components/BookFilterSelector.tsx` | Modify | Filter out excluded books from dropdown; fix "select all" threshold |
| `components/ChapterSelector.tsx` | Modify | Replace 5 exclusion props with single `visibleChapterOrders`; remove inline toggle buttons |

---

### Task 1: BookFilterSelector — hide excluded books

**Files:**
- Modify: `components/BookFilterSelector.tsx:27-55` (getLabel, handleToggle, handleSelectAll)
- Modify: `components/BookFilterSelector.tsx:93` (render list)

- [ ] **Step 1: Filter excluded books from the dropdown list**

In `components/BookFilterSelector.tsx`, change the render loop on line 93 from:

```tsx
{[...series.books].sort((a, b) => a.index - b.index).map((book) => {
```

to:

```tsx
{[...series.books].filter((b) => !b.excluded).sort((a, b) => a.index - b.index).map((book) => {
```

- [ ] **Step 2: Fix "select all" threshold in `handleToggle`**

In the `handleToggle` function (line 36-56), replace:

```tsx
if (next.size === series.books.length) {
  onChange({ mode: 'all' });
  return;
}
```

with:

```tsx
const nonExcludedCount = series.books.filter((b) => !b.excluded).length;
if (next.size === nonExcludedCount) {
  onChange({ mode: 'all' });
  return;
}
```

- [ ] **Step 3: Verify the component renders correctly**

Run: `npx next build`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add components/BookFilterSelector.tsx
git commit -m "fix: hide excluded books from BookFilterSelector dropdown"
```

---

### Task 2: ChapterSelector — replace exclusion props with `visibleChapterOrders`

**Files:**
- Modify: `components/ChapterSelector.tsx:4-34` (Props interface)
- Modify: `components/ChapterSelector.tsx:362-393` (main component, book groups building)
- Modify: `components/ChapterSelector.tsx:698-778` (render: book groups and flat list)

- [ ] **Step 1: Update the Props interface**

In `components/ChapterSelector.tsx`, replace the Props interface (lines 7-34) with:

```tsx
interface Props {
  chapters: EbookChapter[];
  currentIndex: number;
  onChange: (index: number) => void;
  onAnalyze: () => void;
  onCancelAnalyze: () => void;
  onRebuild: () => void;
  onCancelRebuild: () => void;
  analyzing: boolean;
  rebuilding: boolean;
  rebuildProgress: { current: number; total: number; chapterTitle?: string; chapterIndex?: number } | null;
  lastAnalyzedIndex: number | null;
  snapshotIndices?: Set<number>;
  visibleChapterOrders?: Set<number> | null;
  chapterRange?: { start: number; end: number } | null;
  onSetRange?: (range: { start: number; end: number } | null) => void;
  onProcessBook?: () => void;
  onDeleteSnapshot?: (chapterIndex: number) => void;
  readingBookmark?: number;
  onSetBookmark?: (chapterIndex: number | null) => void;
  metaOnly?: boolean;
  needsSetup?: boolean;
  onCompleteSetup?: (range: { start: number; end: number }) => void;
}
```

Removed: `excludedBooks`, `onToggleBook`, `excludedChapters`, `onToggleChapter`, `seriesHiddenChapters`
Added: `visibleChapterOrders`

- [ ] **Step 2: Update the component destructuring**

Replace the destructuring at line 362-368:

```tsx
export default function ChapterSelector({
  chapters, currentIndex, onChange, onAnalyze, onCancelAnalyze, onRebuild, onCancelRebuild,
  analyzing, rebuilding, rebuildProgress, lastAnalyzedIndex,
  snapshotIndices, visibleChapterOrders,
  chapterRange, onSetRange, onProcessBook, onDeleteSnapshot, readingBookmark, onSetBookmark, metaOnly,
  needsSetup, onCompleteSetup,
}: Props) {
```

- [ ] **Step 3: Update book groups building to use `visibleChapterOrders`**

Replace the book groups building block (lines 377-393):

```tsx
  // Build book groups (omnibus only), filtering by visibleChapterOrders
  const bookGroups = new Map<number, {
    bookTitle: string;
    items: Array<{ ch: EbookChapter; globalIndex: number; chapterNum: number }>;
  }>();
  if (isOmnibus) {
    const counters = new Map<number, number>();
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      if (visibleChapterOrders && !visibleChapterOrders.has(i)) continue;
      const bIdx = ch.bookIndex ?? 0;
      if (!bookGroups.has(bIdx)) bookGroups.set(bIdx, { bookTitle: ch.bookTitle ?? '', items: [] });
      const num = (counters.get(bIdx) ?? 0) + 1;
      counters.set(bIdx, num);
      bookGroups.get(bIdx)!.items.push({ ch, globalIndex: i, chapterNum: num });
    }
  }
```

- [ ] **Step 4: Update the `itemProps` to remove toggle callbacks**

Replace the itemProps block (lines 437-444):

```tsx
  const itemProps = {
    currentIndex, lastAnalyzedIndex, snapshotIndices, rebuilding, rebuildProgress, mode, chapters, onChange, setLocationInput,
    onDeleteSnapshot,
    onSetRangeStart: onSetRange ? handleSetRangeStart : undefined,
    onSetRangeEnd: onSetRange ? handleSetRangeEnd : undefined,
    readingBookmark,
    onSetBookmark,
  };
```

Note: `onToggleChapter` removed from itemProps.

- [ ] **Step 5: Remove the book exclude toggle button and `isExcluded` styling from book headers**

In the omnibus book group render (around lines 698-764):

1. Remove the `isExcluded` variable (line 707): `const isExcluded = excludedBooks?.has(bookIdx) ?? false;`

2. Simplify the header styling — remove all `isExcluded` ternary branches from the CSS classes since excluded books are filtered out at the `bookGroups` building stage and never render.

3. Replace the `<div className="flex items-center gap-1.5 pr-2 flex-shrink-0">` block (lines 734-751) with:

```tsx
                    <div className="flex items-center gap-1.5 pr-2 flex-shrink-0">
                      <span className="text-[10px] text-stone-400 dark:text-zinc-600">
                        {analyzedCount > 0 ? `${analyzedCount}/${items.length}` : `${items.length} ch.`}
                      </span>
                    </div>
```

This removes the exclude toggle button entirely since exclusion management lives in BookStructureEditor.

- [ ] **Step 6: Simplify chapter item `isExcluded` in omnibus render**

In the book group chapter render (around line 757-758), since excluded chapters are now filtered out at the `bookGroups` level, simplify:

From:
```tsx
{rangeFilteredItems.map(({ ch, globalIndex }) => (
  <ChapterItem key={ch.id} ch={ch} globalIndex={globalIndex} isExcluded={isExcluded || (excludedChapters?.has(globalIndex) ?? false)} isRangeStart={rangeStart === globalIndex} isRangeEnd={rangeEnd === globalIndex} {...itemProps} />
))}
```

To:
```tsx
{rangeFilteredItems.map(({ ch, globalIndex }) => (
  <ChapterItem key={ch.id} ch={ch} globalIndex={globalIndex} isExcluded={false} isRangeStart={rangeStart === globalIndex} isRangeEnd={rangeEnd === globalIndex} {...itemProps} />
))}
```

Also update the focused-group render (around line 692) similarly — change `isExcluded={isFocusedExcluded || (excludedChapters?.has(globalIndex) ?? false)}` to `isExcluded={false}`.

And remove the `isFocusedExcluded` variable (line 684) and the `isExcluded` variable (line 707) since they're no longer needed.

- [ ] **Step 7: Update the flat (non-omnibus) chapter list**

Replace the flat list filter (lines 771-776):

```tsx
{chapters.map((ch, i) => {
  if (visibleChapterOrders && !visibleChapterOrders.has(i)) return null;
  if (rangeStart !== undefined && i < rangeStart) return null;
  if (rangeEnd !== undefined && i > rangeEnd) return null;
  return <ChapterItem key={ch.id} ch={ch} globalIndex={i} isExcluded={false} isRangeStart={rangeStart === i} isRangeEnd={rangeEnd === i} {...itemProps} />;
})}
```

- [ ] **Step 8: Remove `onToggleChapter` from the ChapterItem component props**

In the `ChapterItemProps` interface (lines 54-75), remove:
```tsx
  onToggleChapter?: (index: number) => void;
```

In the `ChapterItem` destructuring (lines 77-81), remove `onToggleChapter`.

Remove the toggle chapter button JSX block (lines 171-183) — the entire `{onToggleChapter && (...)}` block.

- [ ] **Step 9: Verify build**

Run: `npx next build`
Expected: Build succeeds with no type errors.

- [ ] **Step 10: Commit**

```bash
git add components/ChapterSelector.tsx
git commit -m "refactor: replace exclusion props with visibleChapterOrders in ChapterSelector"
```

---

### Task 3: page.tsx — replace dual-layer filtering with unified `visibleChapterOrders`

**Files:**
- Modify: `app/page.tsx:427-428` (remove excludedBooks/excludedChapters state)
- Modify: `app/page.tsx:470-494` (remove toggleBook/toggleChapter)
- Modify: `app/page.tsx:636-661` (replace filteredSnapshots + seriesHiddenChapters)
- Modify: `app/page.tsx:1155-1187` (update analyzableIndices)
- Modify: `app/page.tsx:1256,1301,1348` (update useCallback deps)
- Modify: `app/page.tsx:1374-1378` (update useDerivedEntities call)
- Modify: `app/page.tsx:1670-1678` (update StoryTimeline props)
- Modify: `app/page.tsx:1804-1831` (update ChapterSelector props)
- Modify: `app/page.tsx:2143-2148` (update CharacterCard props)
- Modify: `app/page.tsx:2155-2168` (update LocationBoard props)
- Modify: `app/page.tsx:2171-2193` (update ArcsPanel props)

- [ ] **Step 1: Remove legacy exclusion state variables**

Delete the `excludedBooks` and `excludedChapters` state declarations (lines 427-428):

```tsx
// DELETE these two lines:
const [excludedBooks, setExcludedBooks] = useState<Set<number>>(new Set());
const [excludedChapters, setExcludedChapters] = useState<Set<number>>(new Set());
```

- [ ] **Step 2: Remove `toggleBook` and `toggleChapter` functions**

Delete the `toggleBook` function (lines 470-481) and `toggleChapter` function (lines 483-494) entirely.

- [ ] **Step 3: Replace `filteredSnapshots` and `seriesHiddenChapters` with `visibleChapterOrders` and `visibleSnapshots`**

Replace lines 636-661 (both useMemo blocks) with:

```tsx
  const visibleChapterOrders = useMemo(() => {
    const series = storedRef.current?.series;
    if (!series) return null;
    const targetBooks = bookFilter.mode === 'all'
      ? series.books
      : series.books.filter((b) => bookFilter.indices.includes(b.index));
    const visible = new Set<number>();
    for (const b of targetBooks) {
      if (b.excluded) continue;
      for (let o = b.chapterStart; o <= b.chapterEnd; o++) {
        if (!b.excludedChapters.includes(o)) visible.add(o);
      }
    }
    return visible;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedRef.current?.series, bookFilter]);

  const visibleSnapshots = useMemo(() => {
    const snaps = storedRef.current?.snapshots ?? [];
    if (!visibleChapterOrders) return snaps;
    return snaps.filter((s) => visibleChapterOrders.has(s.index));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedRef.current?.snapshots, visibleChapterOrders]);
```

- [ ] **Step 4: Add auto-navigate effect**

Add this `useEffect` immediately after the `visibleSnapshots` useMemo:

```tsx
  // Auto-navigate when current chapter falls outside visible set
  useEffect(() => {
    if (!visibleChapterOrders || visibleChapterOrders.size === 0 || visibleChapterOrders.has(currentIndex)) return;
    const stored = storedRef.current;
    if (stored?.snapshots?.length) {
      const visibleSnaps = stored.snapshots
        .filter((s) => visibleChapterOrders.has(s.index))
        .sort((a, b) => b.index - a.index);
      if (visibleSnaps.length > 0) {
        const target = visibleSnaps[0];
        setCurrentIndex(target.index);
        setResult(target.result);
        setViewingSnapshotIndex(target.index);
        return;
      }
    }
    setCurrentIndex(Math.min(...visibleChapterOrders));
  }, [visibleChapterOrders, currentIndex]);
```

- [ ] **Step 5: Update `analyzableIndices` to use `visibleChapterOrders`**

Replace the `analyzableIndices` function (lines 1155-1187) with:

```tsx
  function analyzableIndices(from: number, to: number): number[] {
    if (!book) return [];
    const result: number[] = [];
    for (let i = from; i <= to; i++) {
      const ch = book.chapters[i];
      if (!ch) continue;
      if (visibleChapterOrders && !visibleChapterOrders.has(i)) continue;
      if (!visibleChapterOrders && isFrontMatter(ch)) continue;
      result.push(i);
    }
    return result;
  }
```

- [ ] **Step 6: Update `useCallback` dependency arrays**

In `handleAnalyze` (around line 1256), replace:
```tsx
}, [book, currentIndex, excludedBooks, excludedChapters, chapterRange, needsSetup]);
```
with:
```tsx
}, [book, currentIndex, visibleChapterOrders, chapterRange, needsSetup]);
```

In `handleRebuild` (around line 1301), replace:
```tsx
}, [book, currentIndex, excludedBooks, excludedChapters, chapterRange]);
```
with:
```tsx
}, [book, currentIndex, visibleChapterOrders, chapterRange]);
```

In `handleProcessBook` (around line 1348), replace:
```tsx
}, [book, excludedBooks, excludedChapters, chapterRange]);
```
with:
```tsx
}, [book, visibleChapterOrders, chapterRange]);
```

- [ ] **Step 7: Update `useDerivedEntities` call**

Replace lines 1375-1378:

```tsx
  const derived = useDerivedEntities(
    storedRef.current?.snapshots ?? [],
    result ?? null,
    visibleSnapshots.length !== (storedRef.current?.snapshots ?? []).length ? visibleSnapshots : undefined,
  );
```

- [ ] **Step 8: Update StoryTimeline props**

Replace line 1671:

```tsx
          snapshots={visibleSnapshots}
```

- [ ] **Step 9: Remove `setExcludedBooks`/`setExcludedChapters` calls from book load**

In the book load callback (around lines 966-967), delete:

```tsx
setExcludedBooks(initialStored?.excludedBooks ? new Set(initialStored.excludedBooks) : new Set());
setExcludedChapters(initialStored?.excludedChapters ? new Set(initialStored.excludedChapters) : new Set());
```

Also in line 971, `setBookFilter({ mode: 'all' })` stays as-is.

- [ ] **Step 10: Update ChapterSelector props**

Replace lines 1817-1822:

```tsx
            snapshotIndices={snapshotIndices}
            visibleChapterOrders={visibleChapterOrders}
```

Remove these lines entirely:
```tsx
            excludedBooks={excludedBooks}
            onToggleBook={toggleBook}
            excludedChapters={excludedChapters}
            onToggleChapter={toggleChapter}
            seriesHiddenChapters={seriesHiddenChapters}
```

- [ ] **Step 11: Update CharacterCard snapshots prop**

Replace `snapshots={stored?.snapshots ?? []}` with `snapshots={visibleSnapshots}` in the CharacterCard render (around line 2143).

- [ ] **Step 12: Update LocationBoard snapshots prop**

Replace `snapshots={stored?.snapshots ?? []}` with `snapshots={visibleSnapshots}` in the LocationBoard render (around line 2160).

- [ ] **Step 13: Update ArcsPanel snapshots prop**

Replace `snapshots={stored?.snapshots ?? []}` with `snapshots={visibleSnapshots}` in the ArcsPanel render (around line 2174).

- [ ] **Step 14: Remove unused imports**

Remove `getFilteredChapterOrders` from the import on line 31 if it's no longer used elsewhere in the file. Keep the other imports from `@/lib/series`.

- [ ] **Step 15: Verify build**

Run: `npx next build`
Expected: Build succeeds with no type errors.

- [ ] **Step 16: Commit**

```bash
git add app/page.tsx
git commit -m "feat: replace dual-layer filtering with unified visibleChapterOrders

Removes seriesHiddenChapters, filteredSnapshots, excludedBooks state, and
excludedChapters state. All visibility now flows from a single
visibleChapterOrders set that combines series exclusions with the active
book filter. Adds auto-navigate when current chapter falls outside the
visible set."
```

---

### Task 4: Cleanup — remove unused queue exclusion logic

**Files:**
- Modify: `app/page.tsx:820-840` (queue processor)

The queue processor (around lines 822-839) still uses the old `excludedBooks`/`excludedChapters` from `stored` for background processing. Since the series definition now owns exclusions, update it to use series-based exclusion:

- [ ] **Step 1: Update queue processor exclusion logic**

Replace lines 822-823 and the exclusion check at lines 838-839:

From:
```tsx
const excludedBookSet = new Set(stored.excludedBooks ?? []);
const excludedChapterSet = new Set(stored.excludedChapters ?? []);
```

and:
```tsx
if (ch.bookIndex !== undefined && excludedBookSet.has(ch.bookIndex)) continue;
if (excludedChapterSet.has(i) || isFrontMatter(ch)) {
```

To:
```tsx
const seriesExcluded = new Set<number>();
if (stored.series) {
  for (const b of stored.series.books) {
    if (b.excluded) {
      for (let o = b.chapterStart; o <= b.chapterEnd; o++) seriesExcluded.add(o);
    } else {
      for (const ex of b.excludedChapters) seriesExcluded.add(ex);
    }
  }
  for (const uo of stored.series.unassignedChapters) seriesExcluded.add(uo);
}
```

and:
```tsx
if (stored.series) {
  if (seriesExcluded.has(i)) continue;
} else {
  if (isFrontMatter(ch)) continue;
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build`
Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "refactor: update queue processor to use series-based exclusions"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full build check**

Run: `npx next build`
Expected: Build succeeds with zero errors.

- [ ] **Step 2: Manual smoke test checklist**

Verify these behaviors with a multi-book series:

1. Open a book with a series definition containing excluded books
2. Excluded books do NOT appear in the BookFilterSelector dropdown
3. Excluded books/chapters do NOT appear in the sidebar chapter list
4. Select a single book in the filter → sidebar only shows that book's chapters
5. "Currently at" combobox only shows chapters from the filtered book
6. StoryTimeline only shows snapshots from the filtered book
7. Character/location/arc panels reflect filtered data
8. When filtering to a book that doesn't contain the current chapter → auto-navigates to the last analyzed chapter in that book
9. Open BookStructureEditor → all books (including excluded) are still visible for editing
10. Uncheck a book in BookStructureEditor → it disappears from the filter and sidebar

- [ ] **Step 3: Final commit if any smoke test fixes needed**
