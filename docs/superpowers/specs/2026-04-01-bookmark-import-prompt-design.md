# Bookmark Import Prompt Design

**Date:** 2026-04-01
**Status:** Approved

## Problem

Users who import a `.bookbuddy` file are not prompted to set their reading bookmark. They are immediately shown the full latest analysis, which may contain spoilers. The existing bookmark UI (small hover icons in the chapter sidebar, a dropdown hidden on mobile) is hard to use on mobile devices.

## Solution

A reusable full-screen `BookmarkModal` component with large touch-friendly chapter rows. It is triggered in two contexts:

1. **After import**: Automatically opens when a `.bookbuddy` file is imported, prompting the user to set their reading position
2. **Header button**: A prominent, always-visible bookmark button in the header opens the same modal for updates at any time

## Decisions

- **Always prompt on import**: Even if the imported file has an existing bookmark, prompt the user — they may be a different reader than the exporter
- **Full-screen modal**: Best for mobile touch targets; used in both import and manual-update contexts
- **Single component, two modes**: `'import'` mode (auto-triggered, no clear option) and `'update'` mode (manual, includes clear option)
- **Header button replaces dropdown**: The existing header bookmark dropdown is removed entirely; the modal replaces it
- **No nagging**: If the user dismisses the import prompt without setting a bookmark, no bookmark is set and no further prompts appear

## New Component: `components/BookmarkModal.tsx`

### Props

```typescript
{
  chapters: EbookChapter[];
  currentBookmark: number | null;
  mode: 'import' | 'update';
  onSelect: (chapterIndex: number | null) => void;
  onClose: () => void;
}
```

### Layout

- **Full-screen overlay** with semi-transparent backdrop
- **Header**: "Where are you in this book?" (import mode) or "Update your bookmark" (update mode). Close/X button in top-right.
- **"I haven't started yet" button**: At the top of the list. Sets bookmark to chapter 0 (first chapter). Available in both modes.
- **Chapter list**: Scrollable list of all chapters. Each row ~48px height for touch-friendliness. Shows chapter number and title. Currently bookmarked chapter highlighted in amber. Tapping a chapter sets the bookmark and closes the modal.
- **"Clear bookmark" button**: Only shown in `'update'` mode. Removes bookmark entirely. Calls `onSelect(null)`.

### Behavior

- **Import mode**: `onClose` (backdrop click or X) closes the modal with no bookmark set. No further prompts.
- **Update mode**: `onClose` closes the modal with no changes.
- **Chapter selection**: Calls `onSelect(chapterIndex)`, which triggers the existing `handleSetBookmark()` in the parent.

## Import Flow Integration

### State in `page.tsx`

Two new state variables:
- `showBookmarkModal: boolean` (default `false`)
- `bookmarkModalMode: 'import' | 'update'` (default `'update'`)

### Trigger

In `handleImport()`, after `loadBookFromMeta()` completes successfully, set:
```
showBookmarkModal = true
bookmarkModalMode = 'import'
```

### onSelect Handler

Calls the existing `handleSetBookmark(index)` function, then sets `showBookmarkModal = false`.

### onClose Handler

Sets `showBookmarkModal = false`. No bookmark change.

## Header Bookmark Button

### Replaces

The existing header bookmark dropdown (lines 1572-1611 in `page.tsx`): the `showBookmarkDropdown` state, the dropdown `<div>` with inline chapter list, and the `hidden md:inline-block` responsive hiding.

### When bookmark exists

Amber bookmark icon with "Ch.{N}" label. Always visible (including mobile). Tapping opens `BookmarkModal` in `'update'` mode.

### When no bookmark exists

Subtle outline bookmark icon with "Set bookmark" text. Same header position. Tapping opens `BookmarkModal` in `'update'` mode.

### What gets removed

- `showBookmarkDropdown` state variable
- The entire dropdown `<div>` (chapter list, clear button)
- The `hidden md:inline-block` class that hid the button on mobile
