# Bookmark Import Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen bookmark modal that prompts users to set their reading position after importing a `.bookbuddy` file, and provides an always-visible header button to update it anytime.

**Architecture:** New `BookmarkModal` component with two modes (`'import'` / `'update'`). Two integration points in `page.tsx`: auto-trigger after import, and a header button replacing the existing dropdown.

**Tech Stack:** React, TypeScript, Tailwind CSS (following existing codebase patterns)

---

### Task 1: Create `components/BookmarkModal.tsx`

**Files:**
- Create: `components/BookmarkModal.tsx`

- [ ] **Step 1: Create the full BookmarkModal component**

```typescript
'use client';

import { normalizeTitle } from '@/lib/normalize-title';
import type { EbookChapter } from '@/types';

interface Props {
  chapters: EbookChapter[];
  currentBookmark: number | null;
  mode: 'import' | 'update';
  onSelect: (chapterIndex: number | null) => void;
  onClose: () => void;
}

export default function BookmarkModal({ chapters, currentBookmark, mode, onSelect, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-md p-6 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">
            {mode === 'import' ? 'Where are you in this book?' : 'Update your bookmark'}
          </h2>
          <button
            onClick={onClose}
            className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-stone-500 dark:text-zinc-500 mb-3">
          {mode === 'import'
            ? 'Set your reading position to avoid spoilers.'
            : 'Tap the chapter you\'ve read up to.'}
        </p>

        {/* Chapter list */}
        <div className="overflow-y-auto flex-1 -mx-2">
          {/* "I haven't started yet" option */}
          <button
            onClick={() => onSelect(0)}
            className={`w-full text-left px-3 py-3 text-sm rounded-lg transition-colors flex items-center gap-2 ${
              currentBookmark === 0
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium'
                : 'text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800'
            }`}
          >
            <span className="text-base">📖</span>
            I haven&apos;t started yet
          </button>

          {chapters.map((ch, i) => (
            <button
              key={i}
              onClick={() => onSelect(i)}
              className={`w-full text-left px-3 py-3 text-sm rounded-lg transition-colors truncate ${
                i === currentBookmark
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium'
                  : 'text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800'
              }`}
            >
              {i + 1}. {normalizeTitle(ch.title)}
            </button>
          ))}

          {/* Clear bookmark — update mode only */}
          {mode === 'update' && currentBookmark != null && (
            <button
              onClick={() => onSelect(null)}
              className="w-full text-left px-3 py-3 text-sm rounded-lg transition-colors text-red-400 hover:bg-red-500/10 mt-2 border-t border-stone-200 dark:border-zinc-800 pt-3"
            >
              Clear bookmark
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/BookmarkModal.tsx
git commit -m "feat: add BookmarkModal component for reading position selection"
```

---

### Task 2: Add state variables and import in `page.tsx`

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add the import for BookmarkModal**

Find the import block at the top of `app/page.tsx`. After the existing `LibrarySubmitModal` import (line 25), add:

```typescript
import BookmarkModal from '@/components/BookmarkModal';
```

- [ ] **Step 2: Add state variables**

Find the `showBookmarkDropdown` state declaration (line 591):

```typescript
  const [showBookmarkDropdown, setShowBookmarkDropdown] = useState(false);
```

Replace with:

```typescript
  const [showBookmarkModal, setShowBookmarkModal] = useState(false);
  const [bookmarkModalMode, setBookmarkModalMode] = useState<'import' | 'update'>('update');
```

- [ ] **Step 3: Remove the old dropdown close effect**

Find and remove this entire `useEffect` block (lines 594-599):

```typescript
  useEffect(() => {
    if (!showBookmarkDropdown) return;
    const close = () => setShowBookmarkDropdown(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showBookmarkDropdown]);
```

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add bookmark modal state, remove dropdown state"
```

---

### Task 3: Trigger modal after `.bookbuddy` import

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Update `handleImport()` to trigger the bookmark modal**

Find the `handleImport` function (lines 481-489):

```typescript
  async function handleImport(file: File) {
    setImportError(null);
    try {
      const { title, author } = await importBookBuddy(file);
      loadBookFromMeta(title, author);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    }
  }
```

Replace with:

```typescript
  async function handleImport(file: File) {
    setImportError(null);
    try {
      const { title, author } = await importBookBuddy(file);
      loadBookFromMeta(title, author);
      setBookmarkModalMode('import');
      setShowBookmarkModal(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add app/page.tsx
git commit -m "feat: auto-trigger bookmark modal after .bookbuddy import"
```

---

### Task 4: Replace header bookmark dropdown with modal-opening button

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Replace the header bookmark section**

Find the existing header bookmark dropdown block (lines 1572-1611). It starts with:

```typescript
          {stored?.readingBookmark != null && (
            <div className="relative hidden md:inline-block" onClick={(e) => e.stopPropagation()}>
```

And ends with the closing of that conditional block (the `)}` after the dropdown div closes).

Replace the entire block with:

```typescript
          {hasStoredState && (
            <button
              onClick={() => { setBookmarkModalMode('update'); setShowBookmarkModal(true); }}
              className={`text-xs flex items-center gap-1 transition-colors ${
                stored?.readingBookmark != null
                  ? 'text-amber-500/80 hover:text-amber-500'
                  : 'text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
              }`}
              title="Reading bookmark"
            >
              <svg width="8" height="11" viewBox="0 0 10 14" fill={stored?.readingBookmark != null ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={stored?.readingBookmark != null ? 0 : 1.5} className="flex-shrink-0">
                <path d="M0 0h10v14L5 10.5 0 14V0z"/>
              </svg>
              {stored?.readingBookmark != null ? `Ch.${stored.readingBookmark + 1}` : 'Bookmark'}
            </button>
          )}
```

Key changes:
- Removed `hidden md:inline-block` — button is always visible including mobile
- Removed the entire dropdown `<div>` and its chapter list
- Shows filled amber icon + "Ch.N" when bookmark exists, outline icon + "Bookmark" when not
- Clicking opens the `BookmarkModal` in `'update'` mode
- Condition changed from `stored?.readingBookmark != null` to `hasStoredState` so the button always appears when a book is loaded

- [ ] **Step 2: Commit**

```bash
git add app/page.tsx
git commit -m "feat: replace header bookmark dropdown with modal-opening button"
```

---

### Task 5: Render the BookmarkModal in `page.tsx`

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add the modal render**

Find where existing modals are rendered. There are two render locations for `SettingsModal` (lines 1299 and 1531). Find the one near line 1531:

```typescript
      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); setShowSetupPrompt(false); }} />}
```

Add the `BookmarkModal` render immediately after it:

```typescript
      {showBookmarkModal && book && (
        <BookmarkModal
          chapters={book.chapters}
          currentBookmark={storedRef.current?.readingBookmark ?? null}
          mode={bookmarkModalMode}
          onSelect={(index) => {
            handleSetBookmark(index);
            setShowBookmarkModal(false);
          }}
          onClose={() => setShowBookmarkModal(false)}
        />
      )}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds with no type errors

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: render BookmarkModal in page layout"
```

---

### Task 6: Manual Verification

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test import flow**

Import a `.bookbuddy` file. Verify:
- The bookmark modal appears automatically after the book loads
- Title reads "Where are you in this book?"
- Chapter list is scrollable with large touch targets
- "I haven't started yet" option appears at the top
- Tapping a chapter sets the bookmark and closes the modal
- Clicking the X or backdrop closes the modal without setting a bookmark
- No "Clear bookmark" button visible in import mode

- [ ] **Step 3: Test header button — with bookmark**

After setting a bookmark, verify:
- Header shows amber bookmark icon with "Ch.N"
- Visible on both desktop and mobile viewport widths
- Tapping opens the modal with title "Update your bookmark"
- Current bookmark chapter is highlighted in amber
- "Clear bookmark" button visible at the bottom
- Selecting a new chapter updates the bookmark
- Clearing the bookmark removes it

- [ ] **Step 4: Test header button — without bookmark**

Clear the bookmark, then verify:
- Header shows outline bookmark icon with "Bookmark" text
- Tapping opens the modal in update mode
- Selecting a chapter sets the bookmark

- [ ] **Step 5: Test spoiler protection**

Set a bookmark to an early chapter. Navigate to a later chapter. Verify:
- Spoiler banner appears as expected
- Chapters beyond bookmark are faded in sidebar

- [ ] **Step 6: Final commit and push**

```bash
git add -A
git push origin main
```
