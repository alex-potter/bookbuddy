# Book Split & Boundary Editing UX

**Date:** 2026-04-06
**Approach:** Improved parser + interactive boundary editing (Approach B)

## Problem

When the EPUB parser fails to correctly detect book boundaries in an omnibus, chapters in the misassigned region get fallback "Part N" titles. The user can't identify where one book ends and another begins, and the current split (blind midpoint) doesn't help. Example: Wheel of Time omnibus — Knife of Dreams chapters appear as "Part 611", "Part 613" etc. at the end of Crossroads of Twilight.

**Root cause:** `tryNcxDetection` only maps depth-1 and depth-2 NCX items. When the NCX structure is inconsistent, chapters fall through to "fill forward" logic which absorbs them into the previous book. Title extraction then fails because there's no NCX label and no h1-h3 heading in the HTML.

## Design

### 1. Improved Title Extraction

Enhance the fallback chain in `parseEpub()` (epub-parser.ts lines 71-79):

1. **NCX/nav label** — existing, unchanged
2. **h1-h3 heading** — existing, unchanged
3. **Extended heading scan** (NEW) — look for h4-h6 headings, then scan the first 500 chars of HTML for `<p>` or `<div>` elements that look like titles: elements containing `<b>`/`<strong>`/`<em>` as their only child, elements with class names containing "title", "heading", "chapter", or "ct", or elements with inline styles indicating centering/large font. Take the first match under 100 chars.
4. **First meaningful line** (NEW) — extract the first non-whitespace line of text content, capped at ~80 chars. Stored as a separate `preview` field on the chapter, not as the title. Turns "Part 611" into something identifiable.
5. **"Part N" fallback** — existing, last resort

### 2. Non-Story Content Detection

Tag each chapter at parse time with a `contentType` field: `'story' | 'front-matter' | 'back-matter' | 'structural'`. Default is `'story'`.

**Detection patterns (title-based):**
- **Front matter:** maps, foreword, preface, dedication, acknowledgements, dramatis personae, table of contents, "about the author", copyright
- **Back matter:** glossary, index, appendix, "a note from", "preview of", "excerpt from", "also by", "discussion questions", "reading group guide", bonus material
- **Structural:** pages with very short text (< 50 chars after extraction), title pages that repeat the book name

**In BookStructureEditor:** Non-story chapters are visually dimmed and auto-excluded by default. The user can override. This prevents "GLOSSARY" from being treated as the start of the next book.

### 3. Split Point Picker

Replace the midpoint auto-split with an interactive two-step flow:

1. User taps "Split" on an expanded book → chapter list enters **split-point selection mode**
2. Header prompt: "Tap where the next book starts"
3. Each chapter row becomes tappable with hover/focus highlight
4. Non-story chapters show their content type label (e.g., "GLOSSARY · back-matter"), visually dimmed
5. Chapters with previews show the preview text in a smaller secondary line
6. Tapping a chapter executes the split — everything from that chapter onward becomes the new book
7. New book gets a default title of "Book N" (not "Original Title (Part 2)")
8. "Cancel" option exits split mode without changes

### 4. Draggable Book Boundaries

Each book's start and end boundaries become adjustable via stepper controls:

When a book is expanded, the first and last chapter rows get boundary adjustment controls — small up/down arrow buttons that shift the boundary one chapter at a time:

- **End boundary ↓ (expand):** Absorbs the next chapter from unassigned or the start of the next book
- **End boundary ↑ (shrink):** Releases the last chapter to unassigned
- **Start boundary ↑ (expand):** Absorbs the previous chapter from unassigned or the end of the previous book
- **Start boundary ↓ (shrink):** Releases the first chapter to unassigned

**Constraints:**
- A book must always have at least 1 chapter
- Stealing from an adjacent book shrinks that book — no overlapping ranges
- Unassigned chapters sit in the gaps between books naturally

**Why steppers instead of drag-and-drop:** Touch-based drag on a scrollable list is fiddly, especially in a modal. Steppers are precise, accessible, and work identically on desktop and mobile. Hold/tap repeatedly to move several chapters quickly.

**Visual feedback:** As boundaries shift, the chapter list updates in real-time. Newly absorbed chapters appear at the edge with a subtle highlight. The book's chapter count and range summary in the header update immediately.

### 5. Title Re-extraction After Boundary Changes

When a book's boundaries change (via split or boundary adjustment), chapters with "Part N" fallback titles get a re-extraction pass.

**Trigger:** After any split or boundary adjustment, scan affected book(s) for chapters with titles matching `^Part \d+$`.

**Process:**
1. Read stored chapter HTML from IndexedDB (chapter-storage)
2. Run improved title extraction chain (extended heading scan → first meaningful line)
3. If a better title is found, update the chapter's title in storage
4. Chapter list in the editor refreshes to show new titles

**Scope:** Only runs on "Part N" chapters in affected books — doesn't re-process chapters with real titles. Fast and non-destructive.

### 6. Data Model Changes

**`EbookChapter` additions:**
- `preview?: string` — first meaningful line of content (~80 chars), populated at parse time
- `contentType?: 'story' | 'front-matter' | 'back-matter' | 'structural'` — detected at parse time, defaults to `'story'`

**No changes to `BookDefinition` or `SeriesDefinition`** — split picker and boundary steppers use the existing `chapterStart`/`chapterEnd` model. Non-story auto-exclusion uses the existing `excludedChapters` array.

**`BookStructureEditor` props:** The `chapters` array already carries `order` and `title` — it also needs to carry `preview` and `contentType`, which come naturally from the same chapter objects.

## Files Affected

| File | Changes |
|------|---------|
| `types/index.ts` | Add `preview` and `contentType` to `EbookChapter` |
| `lib/epub-parser.ts` | Enhanced title extraction, content type detection, preview extraction |
| `components/BookStructureEditor.tsx` | Split picker mode, boundary steppers, non-story visual treatment, re-extraction trigger |
| `lib/chapter-storage.ts` | Support for updating chapter titles after re-extraction |
| `lib/series.ts` | Use `contentType` for smarter auto-exclusion |
