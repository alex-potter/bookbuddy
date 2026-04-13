# BookContainer Unified Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SeriesDefinition` with a universal `BookContainer` model so every EPUB gets structure editing, per-book chapter numbering, and multi-EPUB series support.

**Architecture:** Clean cut — no migration. `BookContainer` wraps 1+ `BookDefinition`s and is always present on `StoredBookState`. The EPUB parser returns a `books` array even for single-book EPUBs. The structure editor always opens on first import. A new "Append EPUB" flow adds chapters from separate files into the same container.

**Tech Stack:** Next.js 14 App Router, TypeScript, IndexedDB (via `lib/book-storage.ts`), Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-13-book-container-unified-structure-design.md`

---

### Task 1: Update types — BookContainer replaces SeriesDefinition

**Files:**
- Modify: `types/index.ts:74-94` (BookDefinition, SeriesDefinition, BookFilter)
- Modify: `types/index.ts:166-193` (StoredBookState, BookBuddyExport)

- [ ] **Step 1: Replace SeriesDefinition with BookContainer and update BookDefinition**

In `types/index.ts`, make these changes:

1. Add `sourceEpub` to `BookDefinition` (after `arcGroupingHash`):
```typescript
sourceEpub?: string;        // which EPUB file these chapters came from
```

2. Replace `SeriesDefinition` interface with `BookContainer`:
```typescript
export interface BookContainer {
  books: BookDefinition[];          // always >= 1 entry
  seriesArcs?: ParentArc[];         // series-wide thematic arc groupings (books.length > 1)
  unassignedChapters: number[];     // chapter orders not belonging to any book
}
```

3. Update `StoredBookState` �� replace `series?: SeriesDefinition` with `container: BookContainer` (required). Remove legacy fields `excludedBooks`, `excludedChapters`, `parentArcs`. Keep `chapterRange` (still used by the analysis range/setup flow):
```typescript
export interface StoredBookState {
  lastAnalyzedIndex: number;
  result: AnalysisResult;
  snapshots: Snapshot[];
  bookMeta?: BookMeta;
  readingBookmark?: number;
  readingPosition?: ReadingPosition;
  chapterRange?: { start: number; end: number };
  container: BookContainer;
}
```

4. Update `BookBuddyExport` to version 3:
```typescript
export interface BookBuddyExport {
  version: 3;
  title: string;
  author: string;
  container: BookContainer;
  bookMeta: BookMeta;
  snapshots: Snapshot[];
  result: AnalysisResult;
  mapState: MapState | null;
}
```

- [ ] **Step 2: Verify the types compile**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: Many errors in consuming files (page.tsx, series.ts, etc.) — this is expected. The type definitions themselves should be internally consistent.

- [ ] **Step 3: Commit**

```bash
git add types/index.ts
git commit -m "feat: replace SeriesDefinition with BookContainer in types"
```

---

### Task 2: Rewrite lib/series.ts — container helpers and display numbering

**Files:**
- Modify: `lib/series.ts` (full rewrite)

- [ ] **Step 1: Rewrite series.ts**

Replace the entire file with container-oriented helpers. Remove `buildInitialSeriesDefinition`, `migrateToSeriesDefinition`. Keep and adapt: `computeArcGroupingHash`, `isBookArcStale`, `findBookForChapter`, `arcBookIndices`, `getActiveParentArcs`, `getStaleBooks`.

```typescript
import type { BookDefinition, BookContainer, BookMeta, ParentArc, BookFilter } from '@/types';

/** Build a BookContainer from parsed EPUB data. Always returns a container, even for single-book EPUBs. */
export function buildContainer(
  bookMeta: BookMeta,
  detectRange: (chapters: Array<{ title: string; text: string }>) => { start: number; end: number },
  chapterTexts?: Map<number, { title: string; text: string }>,
  sourceEpub?: string,
): BookContainer {
  const hasMultipleBooks = bookMeta.books && bookMeta.books.length > 1;

  if (!hasMultipleBooks) {
    const allOrders = bookMeta.chapters.map((ch) => ch.order);
    if (allOrders.length === 0) {
      return { books: [{ index: 0, title: 'Book', chapterStart: 0, chapterEnd: 0, excludedChapters: [], confirmed: false, sourceEpub }], unassignedChapters: [] };
    }
    const chapterStart = Math.min(...allOrders);
    const chapterEnd = Math.max(...allOrders);
    let excludedChapters: number[] = [];

    if (chapterTexts) {
      const chapterData: Array<{ order: number; title: string; text: string }> = [];
      for (let o = chapterStart; o <= chapterEnd; o++) {
        const data = chapterTexts.get(o);
        if (data) chapterData.push({ order: o, ...data });
      }
      if (chapterData.length > 0) {
        const range = detectRange(chapterData);
        for (const ch of chapterData) {
          const relIdx = ch.order - chapterStart;
          if (relIdx < range.start || relIdx > range.end) {
            excludedChapters.push(ch.order);
          }
        }
      }
    }

    const bookTitle = bookMeta.books?.[0] ?? 'Book';
    return {
      books: [{ index: 0, title: bookTitle, chapterStart, chapterEnd, excludedChapters, confirmed: false, sourceEpub }],
      unassignedChapters: [],
    };
  }

  // Multi-book EPUB (omnibus)
  const bookChapters = new Map<number, number[]>();
  for (const ch of bookMeta.chapters) {
    if (ch.bookIndex === undefined) continue;
    if (!bookChapters.has(ch.bookIndex)) bookChapters.set(ch.bookIndex, []);
    bookChapters.get(ch.bookIndex)!.push(ch.order);
  }

  const books: BookDefinition[] = [];
  for (let i = 0; i < bookMeta.books!.length; i++) {
    const orders = bookChapters.get(i);
    if (!orders?.length) continue;
    orders.sort((a, b) => a - b);
    const chapterStart = orders[0];
    const chapterEnd = orders[orders.length - 1];

    let excludedChapters: number[] = [];
    if (chapterTexts) {
      const bookChapterData: Array<{ order: number; title: string; text: string }> = [];
      for (let o = chapterStart; o <= chapterEnd; o++) {
        const data = chapterTexts.get(o);
        if (data) bookChapterData.push({ order: o, ...data });
      }
      if (bookChapterData.length > 0) {
        const range = detectRange(bookChapterData);
        for (const ch of bookChapterData) {
          const relIdx = ch.order - chapterStart;
          if (relIdx < range.start || relIdx > range.end) {
            excludedChapters.push(ch.order);
          }
        }
      }
    }

    books.push({
      index: i,
      title: bookMeta.books![i],
      chapterStart,
      chapterEnd,
      excludedChapters,
      confirmed: false,
      sourceEpub,
    });
  }

  const assignedOrders = new Set<number>();
  for (const b of books) {
    for (let o = b.chapterStart; o <= b.chapterEnd; o++) assignedOrders.add(o);
  }
  const allOrders = bookMeta.chapters.map((ch) => ch.order);
  const unassignedChapters = allOrders.filter((o) => !assignedOrders.has(o));

  return { books, unassignedChapters };
}

/** Merge all books in a container into a single BookDefinition. */
export function mergeToSingleBook(container: BookContainer, title?: string): BookContainer {
  if (container.books.length <= 1) return container;
  const sorted = [...container.books].sort((a, b) => a.chapterStart - b.chapterStart);
  const allExcluded = sorted.flatMap((b) => b.excludedChapters);
  const merged: BookDefinition = {
    index: 0,
    title: title ?? sorted[0].title,
    chapterStart: sorted[0].chapterStart,
    chapterEnd: sorted[sorted.length - 1].chapterEnd,
    excludedChapters: allExcluded,
    confirmed: false,
    sourceEpub: sorted[0].sourceEpub,
  };
  return { books: [merged], unassignedChapters: container.unassignedChapters };
}

/** Per-book display chapter number (1-based, skips excluded). */
export function displayChapterNumber(
  container: BookContainer,
  bookIndex: number,
  chapterOrder: number,
): number {
  const book = container.books.find((b) => b.index === bookIndex);
  if (!book) return chapterOrder + 1;
  let num = 0;
  for (let o = book.chapterStart; o <= chapterOrder; o++) {
    if (!book.excludedChapters.includes(o)) num++;
  }
  return num;
}

/** User-facing chapter label. Single book: "Ch. N". Multi-book: "Title — Ch. N". */
export function getDisplayLabel(
  container: BookContainer,
  chapterOrder: number,
): string {
  const book = container.books.find(
    (b) => chapterOrder >= b.chapterStart && chapterOrder <= b.chapterEnd,
  );
  if (!book) return `Ch. ${chapterOrder + 1}`;
  const num = displayChapterNumber(container, book.index, chapterOrder);
  if (container.books.length === 1) return `Ch. ${num}`;
  return `${book.title} — Ch. ${num}`;
}

/** Build the set of excluded chapter orders from the container. */
export function getExcludedOrders(container: BookContainer): Set<number> {
  const excluded = new Set<number>();
  for (const b of container.books) {
    if (b.excluded) {
      for (let o = b.chapterStart; o <= b.chapterEnd; o++) excluded.add(o);
    } else {
      for (const ex of b.excludedChapters) excluded.add(ex);
    }
  }
  for (const uo of container.unassignedChapters) excluded.add(uo);
  return excluded;
}

export function computeArcGroupingHash(book: BookDefinition): string {
  const data = `${book.chapterStart}:${book.chapterEnd}:${book.excludedChapters.sort((a, b) => a - b).join(',')}`;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function isBookArcStale(book: BookDefinition): boolean {
  if (!book.parentArcs?.length) return false;
  if (!book.arcGroupingHash) return true;
  return computeArcGroupingHash(book) !== book.arcGroupingHash;
}

export function findBookForChapter(container: BookContainer, chapterOrder: number): BookDefinition | undefined {
  return container.books.find((b) => chapterOrder >= b.chapterStart && chapterOrder <= b.chapterEnd);
}

export function arcBookIndices(
  arcChapters: number[],
  container: BookContainer,
): number[] {
  const indices = new Set<number>();
  for (const ch of arcChapters) {
    const book = findBookForChapter(container, ch);
    if (book) indices.add(book.index);
  }
  return [...indices].sort((a, b) => a - b);
}

export function getActiveParentArcs(
  container: BookContainer,
  filter: BookFilter,
  fallbackParentArcs?: ParentArc[],
): ParentArc[] {
  if (filter.mode === 'all') {
    return container.seriesArcs ?? fallbackParentArcs ?? [];
  }
  const result: ParentArc[] = [];
  for (const b of container.books) {
    if (b.excluded) continue;
    if (filter.indices.includes(b.index) && b.parentArcs?.length) {
      result.push(...b.parentArcs);
    }
  }
  return result;
}

export function getStaleBooks(container: BookContainer): BookDefinition[] {
  return container.books.filter(isBookArcStale);
}
```

- [ ] **Step 2: Verify series.ts compiles in isolation**

Run: `npx tsc --noEmit lib/series.ts 2>&1 | head -5`
Expected: May fail due to downstream consumers but the file itself should have no internal errors.

- [ ] **Step 3: Commit**

```bash
git add lib/series.ts
git commit -m "feat: rewrite series.ts with BookContainer helpers and display numbering"
```

---

### Task 3: Update epub-parser.ts — always return books array

**Files:**
- Modify: `lib/epub-parser.ts:138`

- [ ] **Step 1: Change the return statement to always include books**

In `lib/epub-parser.ts`, change line 138 from:
```typescript
  return { title, author, chapters, books: books.length > 1 ? books : undefined };
```
to:
```typescript
  return { title, author, chapters, books: books.length > 0 ? books : [title] };
```

This ensures every parsed EPUB has at least one book title in the array. For single-book EPUBs where the parser found no internal divisions, `books` will be empty so we fall back to `[title]` (the EPUB title).

- [ ] **Step 2: Update ParsedEbook type to make books required**

In `types/index.ts`, change:
```typescript
export interface ParsedEbook {
  title: string;
  author: string;
  chapters: EbookChapter[];
  books?: string[];  // individual book titles if omnibus detected
}
```
to:
```typescript
export interface ParsedEbook {
  title: string;
  author: string;
  chapters: EbookChapter[];
  books: string[];   // book titles — always at least one entry
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/epub-parser.ts types/index.ts
git commit -m "feat: epub parser always returns books array"
```

---

### Task 4: Update BookStructureEditor — "Treat as single book" and always-show support

**Files:**
- Modify: `components/BookStructureEditor.tsx`

- [ ] **Step 1: Update Props interface to use BookContainer**

Change the `Props` interface:
```typescript
import type { BookContainer, BookDefinition } from '@/types';

interface Props {
  container: BookContainer;
  chapters: Array<{
    order: number;
    title: string;
    bookIndex?: number;
    preview?: string;
    contentType?: 'story' | 'front-matter' | 'back-matter' | 'structural';
  }>;
  onSave: (container: BookContainer) => void;
  onClose: () => void;
  mode: 'setup' | 'manage';
  onReextract?: (chapterOrders: number[]) => Promise<Map<number, { title: string; preview?: string }>>;
  lockedBookIndices?: Set<number>;
}
```

- [ ] **Step 2: Update component internals — rename series to container**

Inside the component function:
- Change `{ series, ...}` to `{ container, ...}` in destructuring
- Change `useState(() => [...series.books]...)` to `useState(() => [...container.books]...)`
- Change all `series` references in `onSave` calls to use `container`:
  - `handleConfirmAll`: `onSave({ ...container, books: confirmed, unassignedChapters: ... })`
  - `handleSave`: `onSave({ ...container, books: reindexed, unassignedChapters: newUnassigned })`

- [ ] **Step 3: Add "Treat as single book" button**

Add a `handleMergeAll` function using `mergeToSingleBook` from `lib/series.ts`:
```typescript
import { mergeToSingleBook } from '@/lib/series';

function handleMergeAll() {
  const merged = mergeToSingleBook(
    { books, unassignedChapters: localChapters.filter((ch) => !assignedOrders.has(ch.order)).map((ch) => ch.order) },
    books[0]?.title,
  );
  setBooks(merged.books);
}
```

Render the button above the book list, only when `books.length > 1`:
```tsx
{books.length > 1 && (
  <button
    onClick={handleMergeAll}
    className="w-full py-2.5 rounded-xl border border-amber-500/50 text-amber-500 text-sm font-medium hover:bg-amber-500/10 transition-colors"
  >
    Treat as single book
  </button>
)}
```

- [ ] **Step 4: Add locked/read-only state for previously confirmed books**

When `lockedBookIndices` is provided, books in that set render as collapsed and non-interactive:
```tsx
const isLocked = lockedBookIndices?.has(book.index) ?? false;
```

In the book header, if `isLocked`, skip the expand/collapse click handler, hide the checkbox, and show a lock icon or "Confirmed" label. In the expanded section, don't render chapter toggles or split/merge controls.

- [ ] **Step 5: Update header to adapt title by book count**

```tsx
<h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">
  {mode === 'setup'
    ? (books.length > 1 ? 'Confirm Series Structure' : 'Confirm Book Structure')
    : (books.length > 1 ? 'Edit Series Structure' : 'Edit Book Structure')}
</h2>
```

- [ ] **Step 6: Commit**

```bash
git add components/BookStructureEditor.tsx
git commit -m "feat: BookStructureEditor uses BookContainer, adds merge-all and locked books"
```

---

### Task 5: Update BookFilterSelector — use BookContainer

**Files:**
- Modify: `components/BookFilterSelector.tsx:4-12`

- [ ] **Step 1: Replace SeriesDefinition with BookContainer**

Change the import and Props:
```typescript
import type { BookFilter, BookContainer } from '@/types';

interface Props {
  container: BookContainer;
  filter: BookFilter;
  onChange: (filter: BookFilter) => void;
}
```

- [ ] **Step 2: Update all internal references from `series` to `container`**

Replace `series` with `container` in:
- `getLabel()`: `container.books.find(...)`
- `handleToggle()`: `container.books.filter(...)`
- The JSX render: `[...container.books].filter(...)`

- [ ] **Step 3: Commit**

```bash
git add components/BookFilterSelector.tsx
git commit -m "feat: BookFilterSelector uses BookContainer"
```

---

### Task 6: Update WorkshopScreen — use BookContainer

**Files:**
- Modify: `components/workshop/WorkshopScreen.tsx:4,48`

- [ ] **Step 1: Update type import and prop**

Change:
```typescript
import type { ..., SeriesDefinition, ... } from '@/types';
```
to:
```typescript
import type { ..., BookContainer, ... } from '@/types';
```

Change the prop `onSaveSeries: (series: SeriesDefinition) => void` to `onSaveContainer: (container: BookContainer) => void`.

- [ ] **Step 2: Update all internal references**

Search for `series` in the file and update to `container` / `onSaveContainer` as appropriate. The workshop passes the series to `BookStructureEditor` — update that prop from `series={...}` to `container={...}`.

- [ ] **Step 3: Commit**

```bash
git add components/workshop/WorkshopScreen.tsx
git commit -m "feat: WorkshopScreen uses BookContainer"
```

---

### Task 7: Update page.tsx — container creation, always-show editor, series-to-container rename

**Files:**
- Modify: `app/page.tsx`

This is the largest change. Every reference to `.series` becomes `.container`, the gating logic changes to always create a container, and the structure editor always opens on first import.

- [ ] **Step 1: Update imports**

Change line 5:
```typescript
import type { ..., SeriesDefinition, ... } from '@/types';
```
Replace `SeriesDefinition` with `BookContainer`.

Change line 27:
```typescript
import { buildInitialSeriesDefinition, migrateToSeriesDefinition, getActiveParentArcs, getStaleBooks, computeArcGroupingHash } from '@/lib/series';
```
to:
```typescript
import { buildContainer, getActiveParentArcs, getStaleBooks, computeArcGroupingHash, getExcludedOrders } from '@/lib/series';
```

- [ ] **Step 2: Update handleSaveSeries → handleSaveContainer**

Change `handleSaveSeries` (line 550):
```typescript
function handleSaveContainer(updatedContainer: BookContainer) {
  if (!book || !storedRef.current) return;
  const updated = { ...storedRef.current, container: updatedContainer };
  storedRef.current = updated;
  persistState(book.title, book.author, updated);
  setShowBookStructureEditor(false);
}
```

- [ ] **Step 3: Update visibleChapterOrders memo (line 696)**

Replace `storedRef.current?.series` with `storedRef.current?.container`:
```typescript
const visibleChapterOrders = useMemo(() => {
  const container = storedRef.current?.container;
  if (!container) return null;
  const targetBooks = bookFilter.mode === 'all'
    ? container.books
    : container.books.filter((b) => bookFilter.indices.includes(b.index));
  const visible = new Set<number>();
  for (const b of targetBooks) {
    if (b.excluded) continue;
    for (let o = b.chapterStart; o <= b.chapterEnd; o++) {
      if (!b.excludedChapters.includes(o)) visible.add(o);
    }
  }
  return visible;
}, [storedRef.current?.container, bookFilter]);
```

- [ ] **Step 4: Update handleBookLoaded — always create container, always show editor**

In `handleBookLoaded` (around lines 1040-1116), replace the series-creation block:

Remove:
```typescript
if (!stateToSave.series && bookMeta.books && bookMeta.books.length >= 2) {
  // ... migration and build logic
}
```

Replace with:
```typescript
// Always build a container
if (!stateToSave.container) {
  const chapterTexts = new Map<number, { title: string; text: string }>();
  for (const ch of parsed.chapters) {
    chapterTexts.set(ch.order, { title: ch.title, text: ch.text });
  }
  const container = buildContainer(bookMeta, detectChapterRange, chapterTexts, parsed.title);
  stateToSave = { ...stateToSave, container };
}
```

Update the structure editor trigger (around line 1113):
```typescript
// Always show structure editor for new books with unconfirmed structure
if (stateToSave.container.books.some((b) => !b.confirmed)) {
  setBookStructureMode('setup');
  setShowBookStructureEditor(true);
}
```

- [ ] **Step 5: Update loadBookFromMeta — remove legacy migration**

In `loadBookFromMeta` (around line 1119), remove the block:
```typescript
if (!stored.series && stored.bookMeta?.books && stored.bookMeta.books.length >= 2) {
  const series = migrateToSeriesDefinition(stored.bookMeta, stored.excludedBooks);
  if (series) { ... }
}
```

- [ ] **Step 6: Update maybeGenerateParentArcs (line 188)**

Replace all `stored.series` references with `stored.container`:
- Line 200: `if (stored.container && stored.container.books.length > 1)`
- Line 201: `let container = { ...stored.container, books: [...stored.container.books] }`
- Continue replacing throughout the function

- [ ] **Step 7: Update analysis loop — use getExcludedOrders**

In the queue processor (around line 903), replace:
```typescript
const seriesExcluded = new Set<number>();
if (stored.series) {
  for (const b of stored.series.books) { ... }
  for (const uo of stored.series.unassignedChapters) seriesExcluded.add(uo);
}
```
with:
```typescript
const excluded = getExcludedOrders(stored.container);
```

Update the check at line 928 from `if (stored.series)` to `if (excluded.has(i))` (no outer conditional needed).

- [ ] **Step 8: Update arc sync in handleResultUpdate (line 803)**

Replace `if (updated.series)` and `updated.series.books.map(...)` with `updated.container.books.map(...)`:
```typescript
const syncedBooks = updated.container.books.map((b) => { ... });
updated = { ...updated, container: { ...updated.container, books: syncedBooks } };
```

- [ ] **Step 9: Update parent arc save logic (around line 527)**

Replace `stored.series` checks with `stored.container`:
```typescript
if (stored.container.books.length > 1 && bookFilter.mode === 'books' && bookFilter.indices.length === 1) {
  const bookDef = stored.container.books.find((b) => b.index === bookFilter.indices[0]);
  const updatedBooks = stored.container.books.map((b) =>
    b.index === bookFilter.indices[0] ? { ...b, parentArcs } : b
  );
  const updated = { ...stored, container: { ...stored.container, books: updatedBooks } };
  ...
} else if (stored.container.books.length > 1 && bookFilter.mode === 'all') {
  const updated = { ...stored, container: { ...stored.container, seriesArcs: parentArcs.length > 0 ? parentArcs : undefined } };
  ...
}
```

- [ ] **Step 10: Update BookStructureEditor render (line 1725)**

Change:
```tsx
{showBookStructureEditor && book && storedRef.current?.series && (
  <BookStructureEditor
    series={storedRef.current.series}
    ...
    onSave={handleSaveSeries}
```
to:
```tsx
{showBookStructureEditor && book && storedRef.current?.container && (
  <BookStructureEditor
    container={storedRef.current.container}
    ...
    onSave={handleSaveContainer}
```

- [ ] **Step 11: Update export function (line 454)**

Change the `exportBook` function to produce v3 format:
```typescript
const payload: BookBuddyExport = {
  version: 3,
  title,
  author,
  container: state.container,
  bookMeta: state.bookMeta!,
  snapshots: state.snapshots,
  result: state.result,
  mapState: ms,
};
```

- [ ] **Step 12: Update import function (line 52)**

Change `importBookBuddy` to handle v3:
```typescript
async function importBookBuddy(file: File): Promise<{ title: string; author: string }> {
  const text = await file.text();
  const payload = JSON.parse(text) as Partial<BookBuddyExport>;
  if (!payload.title || !payload.author || payload.version !== 3) {
    throw new Error('Invalid or unrecognised .bookbuddy file. Only v3 format is supported.');
  }
  const state: StoredBookState = {
    lastAnalyzedIndex: payload.snapshots?.length ? Math.max(...payload.snapshots.map((s) => s.index)) : -2,
    result: payload.result ?? { characters: [], summary: '' },
    snapshots: payload.snapshots ?? [],
    bookMeta: payload.bookMeta,
    container: payload.container!,
    readingBookmark: undefined,
    readingPosition: undefined,
  };
  await saveBookState(payload.title, payload.author, state);
  if (payload.mapState) await saveBookMapState(payload.title, payload.author, payload.mapState);
  return { title: payload.title, author: payload.author };
}
```

- [ ] **Step 13: Commit**

```bash
git add app/page.tsx
git commit -m "feat: page.tsx uses BookContainer, always creates container, always shows editor"
```

---

### Task 8: Update SeriesPicker — "Add to existing series" option

**Files:**
- Modify: `components/SeriesPicker.tsx`

- [ ] **Step 1: Add "Add to series" option alongside existing "Continue from" flow**

Update the Props interface to include a callback for appending:
```typescript
interface Props {
  newBookTitle: string;
  newBookAuthor: string;
  savedBooks: Array<{
    title: string;
    author: string;
    lastAnalyzedIndex: number;
    hasContainer?: boolean;
  }>;
  onAppendToSeries: (title: string, author: string) => void;
  onContinueFrom: (title: string, author: string) => void;
  onStartFresh: () => void;
}
```

- [ ] **Step 2: Add "Add to existing series" section in the UI**

Above the existing "Continue from" book list, add a section for books that have containers:
```tsx
{savedBooks.filter((b) => b.hasContainer).length > 0 && (
  <div className="mb-4">
    <p className="text-xs font-medium text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">
      Add to existing series
    </p>
    <div className="space-y-2">
      {savedBooks.filter((b) => b.hasContainer).map((book) => (
        <button
          key={`append-${book.title}::${book.author}`}
          onClick={() => onAppendToSeries(book.title, book.author)}
          className="w-full text-left px-4 py-3 rounded-xl border border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-500/5 transition-colors group"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-stone-800 dark:text-zinc-200 text-sm truncate">{book.title}</p>
              <p className="text-xs text-stone-400 dark:text-zinc-500 truncate">{book.author}</p>
            </div>
            <span className="flex-shrink-0 text-xs text-amber-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
              Append →
            </span>
          </div>
          <p className="text-xs text-stone-400 dark:text-zinc-600 mt-1">
            {book.lastAnalyzedIndex + 1} chapter{book.lastAnalyzedIndex !== 0 ? 's' : ''} analyzed
          </p>
        </button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add components/SeriesPicker.tsx
git commit -m "feat: SeriesPicker supports 'Add to existing series' option"
```

---

### Task 9: Implement append-EPUB flow in page.tsx

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add handleAppendToSeries function**

Add a new function that loads the existing book state, parses the new EPUB, rebases chapter orders, and merges into the existing container:

```typescript
async function handleAppendToSeries(existingTitle: string, existingAuthor: string) {
  if (!book) return;
  const existing = await loadBookState(existingTitle, existingAuthor);
  if (!existing?.container || !existing.bookMeta) return;

  const maxOrder = Math.max(...existing.bookMeta.chapters.map((ch) => ch.order));
  const offset = maxOrder + 1;

  // Rebase new EPUB's chapters
  const rebasedChapters = book.chapters.map((ch, i) => ({
    ...ch,
    order: ch.order + offset,
    bookIndex: (ch.bookIndex ?? 0) + existing.container.books.length,
  }));

  // Merge bookMeta
  const newBookTitles = book.books ?? [book.title];
  const mergedBookMeta: BookMeta = {
    chapters: [
      ...existing.bookMeta.chapters,
      ...rebasedChapters.map(({ id, title, order, bookIndex, bookTitle, preview, contentType }) =>
        ({ id, title, order, bookIndex, bookTitle, preview, contentType })),
    ],
    books: [...(existing.bookMeta.books ?? []), ...newBookTitles],
  };

  // Build container entries for the new book(s)
  const chapterTexts = new Map<number, { title: string; text: string }>();
  for (const ch of rebasedChapters) {
    chapterTexts.set(ch.order, { title: ch.title, text: ch.text });
  }
  const newContainer = buildContainer(
    { chapters: mergedBookMeta.chapters.filter((ch) => (ch.bookIndex ?? 0) >= existing.container.books.length), books: newBookTitles },
    detectChapterRange,
    chapterTexts,
    book.title,
  );

  // Reindex new books to continue from existing
  const reindexedNewBooks = newContainer.books.map((b, i) => ({
    ...b,
    index: existing.container.books.length + i,
    chapterStart: b.chapterStart + offset,
    chapterEnd: b.chapterEnd + offset,
    excludedChapters: b.excludedChapters.map((o) => o + offset),
  }));

  const mergedContainer: BookContainer = {
    books: [...existing.container.books, ...reindexedNewBooks],
    seriesArcs: existing.container.seriesArcs,
    unassignedChapters: [
      ...existing.container.unassignedChapters,
      ...newContainer.unassignedChapters.map((o) => o + offset),
    ],
  };

  // Save chapter texts for new book
  const { saveChapters } = await import('@/lib/chapter-storage');
  const chaptersWithText = rebasedChapters.filter((ch) => ch.text).map((ch) => ({
    id: ch.id,
    text: ch.text,
    htmlHead: (ch as unknown as Record<string, string>)._htmlHead,
  }));
  if (chaptersWithText.length > 0) {
    await saveChapters(existingTitle, existingAuthor, chaptersWithText).catch(() => {});
  }

  // Prompt for series title if going from 1 to 2+ books
  let seriesTitle = existingTitle;
  let seriesAuthor = existingAuthor;
  if (existing.container.books.length === 1) {
    const suggested = `${existingTitle} series`;
    const userTitle = prompt('Name this series:', suggested);
    if (userTitle?.trim()) seriesTitle = userTitle.trim();
  }

  const updatedState: StoredBookState = {
    ...existing,
    bookMeta: mergedBookMeta,
    container: mergedContainer,
  };

  // If title changed (series rename), save under new key and delete old
  if (seriesTitle !== existingTitle) {
    await saveBookState(seriesTitle, seriesAuthor, updatedState);
    await deleteBookState(existingTitle, existingAuthor).catch(() => {});
  } else {
    await saveBookState(existingTitle, existingAuthor, updatedState);
  }

  // Reload the merged book
  await loadBookFromMeta(seriesTitle, seriesAuthor);

  // Show editor scoped to new books
  const lockedIndices = new Set(existing.container.books.map((b) => b.index));
  setLockedBookIndices(lockedIndices);
  setBookStructureMode('setup');
  setShowBookStructureEditor(true);
}
```

- [ ] **Step 2: Add lockedBookIndices state**

Near the other state declarations:
```typescript
const [lockedBookIndices, setLockedBookIndices] = useState<Set<number> | undefined>(undefined);
```

Pass to `BookStructureEditor`:
```tsx
<BookStructureEditor
  container={storedRef.current.container}
  ...
  lockedBookIndices={lockedBookIndices}
/>
```

- [ ] **Step 3: Wire SeriesPicker's onAppendToSeries**

Where `SeriesPicker` is rendered, add the `onAppendToSeries={handleAppendToSeries}` prop and pass `hasContainer` in the saved books list.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: implement append-EPUB flow for multi-EPUB series"
```

---

### Task 10: Update ChapterSelector — per-book display numbering

**Files:**
- Modify: `components/ChapterSelector.tsx`

- [ ] **Step 1: Add container prop**

Add to the `Props` interface:
```typescript
import type { BookContainer } from '@/types';

// In Props:
container?: BookContainer;
```

- [ ] **Step 2: Update ChapterCombobox subLabel to use per-book numbering**

In the `ChapterCombobox` component (line 188), update the `subLabel` computation to use `getDisplayLabel` when `container` is available. Pass `container` as a prop to `ChapterCombobox`:

```typescript
import { getDisplayLabel } from '@/lib/series';

// In ComboboxProps, add: container?: BookContainer;
// In subLabel:
const subLabel = container
  ? getDisplayLabel(container, currentCh.order)
  : (() => { /* existing fallback logic */ })();
```

- [ ] **Step 3: Update chapter number display in flatItems**

In the `ChapterCombobox` flatItems construction, when `container` is provided, use `displayChapterNumber` instead of the raw counter:

```typescript
import { displayChapterNumber, findBookForChapter } from '@/lib/series';
```

Update the number prefix in the dropdown items to use per-book numbering.

- [ ] **Step 4: Update book group headers to use container book titles**

When `container` is provided, build `bookGroups` from the container's `BookDefinition` entries instead of raw `bookIndex`/`bookTitle` chapter fields. This ensures merged books display correctly.

- [ ] **Step 5: Commit**

```bash
git add components/ChapterSelector.tsx
git commit -m "feat: ChapterSelector uses per-book display numbering from BookContainer"
```

---

### Task 11: Update StoryTimeline — per-book chapter labels

**Files:**
- Modify: `components/StoryTimeline.tsx`

- [ ] **Step 1: Add container prop**

```typescript
import type { BookContainer } from '@/types';

// In StoryTimelineProps:
container?: BookContainer;
```

- [ ] **Step 2: Use getDisplayLabel for chapter title display**

Import `getDisplayLabel` from `@/lib/series`. Where `chapterTitles[snap.index]` is used to display chapter names (e.g., in the timeline header, the chapter span labels), replace with:

```typescript
const label = container
  ? getDisplayLabel(container, snap.index)
  : (chapterTitles[snap.index] ?? `Ch. ${snap.index + 1}`);
```

- [ ] **Step 3: Commit**

```bash
git add components/StoryTimeline.tsx
git commit -m "feat: StoryTimeline uses per-book chapter labels"
```

---

### Task 12: Update ArcsPanel — use container for chapter labels

**Files:**
- Modify: `components/ArcsPanel.tsx`

- [ ] **Step 1: Add container prop**

```typescript
import type { BookContainer } from '@/types';

// In Props:
container?: BookContainer;
```

- [ ] **Step 2: Use getDisplayLabel in arc chapter span bar**

Import `getDisplayLabel` from `@/lib/series`. In `renderArcCard`, where chapter titles are shown (lines 134-137), use:

```typescript
const chLabel = container
  ? getDisplayLabel(container, idx)
  : (chapterTitles[idx] ?? `Ch. ${idx + 1}`);
```

Replace `chapterTitles[firstCh]`, `chapterTitles[lastCh]`, and `chapterTitles[idx]` with the container-aware version.

- [ ] **Step 3: Commit**

```bash
git add components/ArcsPanel.tsx
git commit -m "feat: ArcsPanel uses per-book chapter labels from container"
```

---

### Task 13: Wire updated components into page.tsx and verify build

**Files:**
- Modify: `app/page.tsx` (pass container prop to ChapterSelector, StoryTimeline, ArcsPanel, BookFilterSelector)

- [ ] **Step 1: Pass container to ChapterSelector**

Find where `<ChapterSelector>` is rendered and add:
```tsx
container={storedRef.current?.container}
```

- [ ] **Step 2: Pass container to StoryTimeline**

Find where `<StoryTimeline>` is rendered and add:
```tsx
container={storedRef.current?.container}
```

- [ ] **Step 3: Pass container to ArcsPanel**

Find where `<ArcsPanel>` is rendered and add:
```tsx
container={storedRef.current?.container}
```

- [ ] **Step 4: Pass container to BookFilterSelector**

Find where `<BookFilterSelector>` is rendered and change `series={...}` to `container={storedRef.current!.container}`. Only render when `storedRef.current?.container?.books.length > 1`.

- [ ] **Step 5: Run full build**

Run: `npm run build`
Expected: Successful build with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx
git commit -m "feat: wire BookContainer prop to all updated components"
```

---

### Task 14: Manual integration test

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Test Scenario A — single-book EPUB**

1. Load a single-book EPUB (e.g., one that was previously treated as standalone)
2. Verify the structure editor appears
3. Verify front/back matter is auto-excluded
4. Confirm the structure
5. Verify chapter numbers show as "Ch. 1", "Ch. 2" etc. (no book prefix)
6. Verify analysis works normally

- [ ] **Step 3: Test Scenario C — omnibus with "Parts"**

1. Load Way of Kings EPUB
2. Verify the structure editor shows detected parts
3. Click "Treat as single book" — verify all parts merge into one entry
4. Exclude front/back matter chapters
5. Confirm and verify chapters are numbered starting at Ch. 1

- [ ] **Step 4: Test export/import**

1. Export a book as .bookbuddy file
2. Delete the book from the library
3. Import the .bookbuddy file
4. Verify all data is restored

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes for BookContainer"
```
