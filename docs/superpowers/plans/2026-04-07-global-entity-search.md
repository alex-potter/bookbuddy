# Global Entity Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating search button that opens a bottom sheet for searching characters, locations, and arcs in the current book, with preview cards and full modal access.

**Architecture:** A `SearchFAB` button and `SearchSheet` component are added to `page.tsx`. The sheet receives aggregated entity data already computed by `useDerivedEntities`. On "View Details", the sheet calls back to page.tsx which renders the appropriate entity modal using the same pattern as EntityManager.

**Tech Stack:** React 18, Next.js 14, TailwindCSS, TypeScript

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `components/SearchFAB.tsx` | Create | Floating search button, fixed bottom-right |
| `components/SearchSheet.tsx` | Create | Bottom sheet with search, results, preview states |
| `app/page.tsx` | Modify | Wire up FAB, sheet, and modal rendering for search |

---

### Task 1: Create SearchFAB Component

**Files:**
- Create: `components/SearchFAB.tsx`

- [ ] **Step 1: Create the SearchFAB component**

```tsx
// components/SearchFAB.tsx
'use client';

interface Props {
  onClick: () => void;
}

export default function SearchFAB({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      aria-label="Search entities"
      className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-stone-800 dark:bg-zinc-700 text-white shadow-lg active:scale-95 transition-transform"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
        <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
      </svg>
    </button>
  );
}
```

- [ ] **Step 2: Verify it renders**

Run the dev server, confirm the FAB appears fixed at bottom-right on mobile viewport.

- [ ] **Step 3: Commit**

```bash
git add components/SearchFAB.tsx
git commit -m "feat: add SearchFAB floating action button component"
```

---

### Task 2: Create SearchSheet Component — Shell & Search Input

**Files:**
- Create: `components/SearchSheet.tsx`

- [ ] **Step 1: Create the SearchSheet shell with open/close animation and search input**

```tsx
// components/SearchSheet.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import type { Character, LocationInfo, NarrativeArc } from '@/types';
import type { AggregatedCharacter, AggregatedLocation, AggregatedArc } from '@/lib/aggregate-entities';

type SheetView = 'results' | 'preview';
type EntityType = 'character' | 'location' | 'arc';

interface SearchResult {
  type: EntityType;
  name: string;
  aliases: string[];
  description: string;
  // Character-specific
  status?: Character['status'];
  importance?: Character['importance'];
  currentLocation?: string;
  // Location-specific
  parentLocation?: string;
  arc?: string;
  // Arc-specific
  arcStatus?: NarrativeArc['status'];
  characterCount?: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onEntitySelect: (type: EntityType, name: string) => void;
  characters: AggregatedCharacter[];
  locations: AggregatedLocation[];
  arcs: AggregatedArc[];
}

const TYPE_BADGE: Record<EntityType, { label: string; className: string }> = {
  character: { label: 'Character', className: 'bg-rose-500/15 text-rose-400' },
  location:  { label: 'Location',  className: 'bg-sky-500/15 text-sky-400' },
  arc:       { label: 'Arc',       className: 'bg-violet-500/15 text-violet-400' },
};

function buildSearchItems(
  characters: AggregatedCharacter[],
  locations: AggregatedLocation[],
  arcs: AggregatedArc[],
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const c of characters) {
    results.push({
      type: 'character',
      name: c.character.name,
      aliases: c.character.aliases ?? [],
      description: c.character.description,
      status: c.character.status,
      importance: c.character.importance,
      currentLocation: c.character.currentLocation,
    });
  }
  for (const l of locations) {
    results.push({
      type: 'location',
      name: l.location.name,
      aliases: l.location.aliases ?? [],
      description: l.location.description,
      parentLocation: l.location.parentLocation,
      arc: l.location.arc,
    });
  }
  for (const a of arcs) {
    results.push({
      type: 'arc',
      name: a.arc.name,
      aliases: [],
      description: a.arc.summary,
      arcStatus: a.arc.status,
      characterCount: a.arc.characters.length,
    });
  }
  return results;
}

function matchesQuery(item: SearchResult, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (item.name.toLowerCase().includes(q)) return true;
  return item.aliases.some((a) => a.toLowerCase().includes(q));
}

export default function SearchSheet({ isOpen, onClose, onEntitySelect, characters, locations, arcs }: Props) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<SheetView>('results');
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Reset state when sheet opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setView('results');
      setSelected(null);
      // Delay focus to after animation
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Swipe-to-dismiss tracking
  const touchStartY = useRef(0);
  const touchCurrentY = useRef(0);
  const isDragging = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    isDragging.current = true;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging.current) return;
    touchCurrentY.current = e.touches[0].clientY;
    const delta = touchCurrentY.current - touchStartY.current;
    if (delta > 0 && sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${delta}px)`;
    }
  };

  const handleTouchEnd = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const delta = touchCurrentY.current - touchStartY.current;
    if (sheetRef.current) {
      sheetRef.current.style.transform = '';
    }
    if (delta > 100) {
      onClose();
    }
  };

  if (!isOpen) return null;

  const allItems = buildSearchItems(characters, locations, arcs);
  const filtered = allItems.filter((item) => matchesQuery(item, query));

  // Sort: characters first, then locations, then arcs; alpha within each group
  const typeOrder: Record<EntityType, number> = { character: 0, location: 1, arc: 2 };
  filtered.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || a.name.localeCompare(b.name));

  const handleResultTap = (item: SearchResult) => {
    setSelected(item);
    setView('preview');
  };

  const handleBack = () => {
    setView('results');
    setSelected(null);
  };

  const handleViewDetails = () => {
    if (!selected) return;
    onEntitySelect(selected.type, selected.name);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col bg-white dark:bg-zinc-900 rounded-t-2xl shadow-2xl transition-transform duration-300"
        style={{ maxHeight: '70vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-stone-300 dark:bg-zinc-700" />
        </div>

        {view === 'results' ? (
          <>
            {/* Search input */}
            <div className="px-4 pb-3">
              <input
                ref={inputRef}
                type="search"
                placeholder="Search characters, locations, arcs\u2026"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full text-sm px-3 py-2 rounded-lg border bg-transparent outline-none transition-colors border-stone-300 dark:border-zinc-700 text-stone-700 dark:text-zinc-300 placeholder-stone-400 dark:placeholder-zinc-600 focus:border-stone-400 dark:focus:border-zinc-500"
              />
            </div>

            {/* Results list */}
            <div className="flex-1 overflow-y-auto px-3 pb-4">
              {query && filtered.length === 0 && (
                <p className="text-sm text-stone-400 dark:text-zinc-600 text-center py-8">No matches found</p>
              )}
              {!query && (
                <p className="text-sm text-stone-400 dark:text-zinc-600 text-center py-8">Type to search\u2026</p>
              )}
              {query && filtered.map((item) => (
                <button
                  key={`${item.type}-${item.name}`}
                  onClick={() => handleResultTap(item)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800 active:bg-stone-200 dark:active:bg-zinc-700 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{item.name}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TYPE_BADGE[item.type].className}`}>
                      {TYPE_BADGE[item.type].label}
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-400 dark:text-zinc-600 line-clamp-1 mt-0.5">{item.description}</p>
                </button>
              ))}
            </div>
          </>
        ) : (
          /* Preview card — implemented in Task 3 */
          null
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify the shell renders**

Temporarily wire it up in page.tsx (next task does this properly) or test visually that the component structure is correct.

- [ ] **Step 3: Commit**

```bash
git add components/SearchSheet.tsx
git commit -m "feat: add SearchSheet component with search input and results list"
```

---

### Task 3: Add Preview Card to SearchSheet

**Files:**
- Modify: `components/SearchSheet.tsx` (the `null` placeholder in the `view === 'preview'` branch)

- [ ] **Step 1: Replace the preview placeholder with the preview card implementation**

Replace the line `/* Preview card — implemented in Task 3 */` and its surrounding `null` with:

```tsx
          /* Preview card */
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {/* Back button */}
            <button
              onClick={handleBack}
              className="flex items-center gap-1 text-sm text-stone-500 dark:text-zinc-400 mb-3 active:text-stone-700 dark:active:text-zinc-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
              </svg>
              Back to results
            </button>

            {selected && (
              <div className="rounded-xl border border-stone-200 dark:border-zinc-800 p-4">
                {/* Header */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-base font-semibold text-stone-800 dark:text-zinc-200">{selected.name}</span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TYPE_BADGE[selected.type].className}`}>
                    {TYPE_BADGE[selected.type].label}
                  </span>
                </div>

                {/* Character preview */}
                {selected.type === 'character' && (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      {selected.status && (
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_BADGE_STYLES[selected.status]}`}>
                          {selected.status.charAt(0).toUpperCase() + selected.status.slice(1)}
                        </span>
                      )}
                      {selected.importance && (
                        <span className="text-xs text-stone-400 dark:text-zinc-500 capitalize">{selected.importance}</span>
                      )}
                    </div>
                    {selected.currentLocation && (
                      <p className="text-stone-500 dark:text-zinc-400">
                        <span className="text-stone-400 dark:text-zinc-600 text-xs uppercase tracking-wider">Location </span>
                        {selected.currentLocation}
                      </p>
                    )}
                    <p className="text-stone-600 dark:text-zinc-400 line-clamp-3">{selected.description}</p>
                  </div>
                )}

                {/* Location preview */}
                {selected.type === 'location' && (
                  <div className="space-y-2 text-sm">
                    {selected.parentLocation && (
                      <p className="text-stone-500 dark:text-zinc-400">
                        <span className="text-stone-400 dark:text-zinc-600 text-xs uppercase tracking-wider">Part of </span>
                        {selected.parentLocation}
                      </p>
                    )}
                    {selected.arc && (
                      <p className="text-stone-500 dark:text-zinc-400">
                        <span className="text-stone-400 dark:text-zinc-600 text-xs uppercase tracking-wider">Arc </span>
                        {selected.arc}
                      </p>
                    )}
                    <p className="text-stone-600 dark:text-zinc-400 line-clamp-3">{selected.description}</p>
                  </div>
                )}

                {/* Arc preview */}
                {selected.type === 'arc' && (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      {selected.arcStatus && (
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${ARC_STATUS_STYLES[selected.arcStatus]}`}>
                          {selected.arcStatus.charAt(0).toUpperCase() + selected.arcStatus.slice(1)}
                        </span>
                      )}
                      {selected.characterCount !== undefined && (
                        <span className="text-xs text-stone-400 dark:text-zinc-500">
                          {selected.characterCount} character{selected.characterCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-stone-600 dark:text-zinc-400 line-clamp-3">{selected.description}</p>
                  </div>
                )}

                {/* View Details button */}
                <button
                  onClick={handleViewDetails}
                  className="mt-4 w-full py-2 rounded-lg bg-stone-800 dark:bg-zinc-700 text-white text-sm font-medium active:scale-[0.98] transition-transform"
                >
                  View Details
                </button>
              </div>
            )}
          </div>
```

- [ ] **Step 2: Add status style constants above the component function**

Add these constants after the existing `TYPE_BADGE` constant:

```tsx
const STATUS_BADGE_STYLES: Record<string, string> = {
  alive:     'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  dead:      'bg-red-500/10 text-red-400 border-red-500/20',
  unknown:   'bg-stone-200/50 dark:bg-zinc-700/50 text-stone-500 dark:text-zinc-400 border-stone-400/30 dark:border-zinc-600/30',
  uncertain: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

const ARC_STATUS_STYLES: Record<string, string> = {
  active:   'bg-amber-500/15 text-amber-400 border-amber-500/25',
  resolved: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  dormant:  'bg-stone-400/15 text-stone-400 border-stone-400/25 dark:bg-zinc-600/15 dark:text-zinc-400',
};
```

- [ ] **Step 3: Verify the preview card renders**

Open the sheet, search for an entity, tap it, confirm the preview renders with back button and View Details.

- [ ] **Step 4: Commit**

```bash
git add components/SearchSheet.tsx
git commit -m "feat: add preview card state to SearchSheet"
```

---

### Task 4: Wire SearchFAB and SearchSheet into page.tsx

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Add imports**

Add these imports at the top of page.tsx alongside the existing component imports:

```tsx
import SearchFAB from '@/components/SearchFAB';
import SearchSheet from '@/components/SearchSheet';
```

- [ ] **Step 2: Add search state variables**

Add these state variables near the existing modal/UI state (around line 623, after the existing `useState` calls):

```tsx
const [showSearch, setShowSearch] = useState(false);
const [searchEntity, setSearchEntity] = useState<{ type: 'character' | 'location' | 'arc'; name: string } | null>(null);
```

- [ ] **Step 3: Add the search entity select handler**

Add this handler function near the other handlers in page.tsx:

```tsx
const handleSearchEntitySelect = useCallback((type: 'character' | 'location' | 'arc', name: string) => {
  setShowSearch(false);
  setSearchEntity({ type, name });
}, []);
```

- [ ] **Step 4: Render SearchFAB and SearchSheet before the closing `</main>` tag**

Insert before the `</main>` closing tag (line 2332):

```tsx
      {/* Global entity search */}
      {result && stored && !showSearch && !searchEntity && (
        <SearchFAB onClick={() => setShowSearch(true)} />
      )}
      {result && stored && (
        <SearchSheet
          isOpen={showSearch}
          onClose={() => setShowSearch(false)}
          onEntitySelect={handleSearchEntitySelect}
          characters={derived.aggregated.characters}
          locations={derived.aggregated.locations}
          arcs={derived.aggregated.arcs}
        />
      )}
```

- [ ] **Step 5: Render entity modals from search selection**

Insert after the SearchSheet block:

```tsx
      {/* Modals opened from search */}
      {searchEntity?.type === 'character' && (() => {
        let char = result?.characters.find((c) => c.name === searchEntity.name);
        if (!char) {
          char = derived.aggregated.characters.find((e) => e.character.name === searchEntity.name)?.character;
        }
        if (!char) return null;
        const inCurrent = !!result?.characters.find((c) => c.name === searchEntity.name);
        return (
          <CharacterModal
            character={char}
            snapshots={stored?.snapshots ?? []}
            chapterTitles={book?.chapters.map((ch) => ch.title) ?? []}
            currentResult={inCurrent ? result : undefined}
            onResultEdit={inCurrent ? applyResultEdit : undefined}
            currentChapterIndex={currentChapterIndex}
            onClose={() => setSearchEntity(null)}
            onEntityClick={(type, name) => {
              setSearchEntity({ type, name });
            }}
          />
        );
      })()}
      {searchEntity?.type === 'location' && (() => {
        const inCurrent = result?.locations?.some((l) => l.name === searchEntity.name) ?? false;
        return (
          <LocationModal
            locationName={searchEntity.name}
            snapshots={stored?.snapshots ?? []}
            chapterTitles={book?.chapters.map((ch) => ch.title) ?? []}
            currentResult={inCurrent ? result : undefined}
            onResultEdit={inCurrent ? applyResultEdit : undefined}
            currentChapterIndex={currentChapterIndex}
            onClose={() => setSearchEntity(null)}
            onEntityClick={(type, name) => {
              setSearchEntity({ type, name });
            }}
          />
        );
      })()}
      {searchEntity?.type === 'arc' && (() => {
        const inCurrent = result?.arcs?.some((a) => a.name === searchEntity.name) ?? false;
        return (
          <NarrativeArcModal
            arcName={searchEntity.name}
            snapshots={stored?.snapshots ?? []}
            chapterTitles={book?.chapters.map((ch) => ch.title) ?? []}
            currentResult={inCurrent ? result : undefined}
            onResultEdit={inCurrent ? applyResultEdit : undefined}
            currentChapterIndex={currentChapterIndex}
            onClose={() => setSearchEntity(null)}
            onEntityClick={(type, name) => {
              setSearchEntity({ type, name });
            }}
          />
        );
      })()}
```

Note: `CharacterModal`, `LocationModal`, and `NarrativeArcModal` are not currently imported in page.tsx. Add these imports at the top:

```tsx
import CharacterModal from '@/components/CharacterModal';
import LocationModal from '@/components/LocationModal';
import NarrativeArcModal from '@/components/NarrativeArcModal';
```

- [ ] **Step 6: Verify end-to-end flow**

1. Load a book with analyzed chapters
2. Tap the FAB — bottom sheet opens
3. Type a character name — results appear
4. Tap a result — preview card shows
5. Tap "View Details" — full modal opens, sheet dismisses
6. Close the modal — FAB reappears
7. Cross-entity linking works inside the modal (tap a character's location opens LocationModal)

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx
git commit -m "feat: wire SearchFAB and SearchSheet into page with modal rendering"
```

---

### Task 5: Polish & Edge Cases

**Files:**
- Modify: `components/SearchSheet.tsx`

- [ ] **Step 1: Add slide-up animation**

Wrap the sheet's `className` with a conditional for the open animation. Replace the sheet's outer `className`:

```tsx
className={`fixed inset-x-0 bottom-0 z-50 flex flex-col bg-white dark:bg-zinc-900 rounded-t-2xl shadow-2xl transition-transform duration-300 ${
  isOpen ? 'translate-y-0' : 'translate-y-full'
}`}
```

And change the component to always render (remove the `if (!isOpen) return null;` guard), instead using the backdrop's visibility:

```tsx
if (!isOpen) return null;
```

becomes:

```tsx
// Keep rendering for exit animation — but skip if never opened
```

Actually, since we need to keep it simple and the sheet remounts on each open anyway (state resets), keep the `if (!isOpen) return null;` as-is. The entry animation will play via the CSS transition on mount. This is sufficient for mobile feel.

- [ ] **Step 2: Handle empty entity lists gracefully**

In `SearchSheet`, if all three entity arrays are empty (no analysis done yet), show a message. Add this check inside the results view, before the existing empty/query checks:

```tsx
{allItems.length === 0 && (
  <p className="text-sm text-stone-400 dark:text-zinc-600 text-center py-8">No entities to search yet</p>
)}
```

- [ ] **Step 3: Ensure the sheet doesn't block scroll on the body**

Add body scroll lock when sheet is open. In the `useEffect` that fires on `isOpen`:

```tsx
useEffect(() => {
  if (isOpen) {
    setQuery('');
    setView('results');
    setSelected(null);
    setTimeout(() => inputRef.current?.focus(), 100);
    document.body.style.overflow = 'hidden';
  }
  return () => {
    document.body.style.overflow = '';
  };
}, [isOpen]);
```

- [ ] **Step 4: Test on mobile viewport**

Test in Chrome DevTools mobile mode:
- Sheet covers ~70% of screen
- Swipe down dismisses
- Keyboard opens and input is visible above it
- Results scroll within the sheet
- Preview card back button works

- [ ] **Step 5: Commit**

```bash
git add components/SearchSheet.tsx
git commit -m "feat: polish SearchSheet with body scroll lock and empty state handling"
```
