# Mobile-First UX Redesign

## Problem

BookBuddy's current UI is desktop-first with a sidebar layout that doesn't work well on mobile. Three specific pain points:

1. **Information density** — cards waste vertical space; too much scrolling to find what you need
2. **Chapter selector complexity** — the chapter panel mixes navigation, analysis controls, range editing, and bookmarks into one overloaded surface
3. **Dated visual feel** — default Tailwind styling with no distinctive character

## Core Architectural Decision: Explore vs Workshop

The app serves two fundamentally different task paths:

- **Explore** — looking up characters, checking locations, reviewing arcs while reading. This is the primary mode (90% of usage). It should be fast, glanceable, and optimized for one-handed mobile use.
- **Workshop** — analyzing chapters, editing book structure, managing the library, configuring settings. This is infrequent and can afford more complexity.

Workshop lives behind an overflow menu on Explore's header. It is deliberately less prominent — it should not compete for screen real estate with Explore.

## Aesthetic: Tactile Paperback

A warm, literary aesthetic that feels like holding a well-loved paperback.

### Palette Tokens

CSS custom properties on `:root`:

| Token | Light | Dark |
|---|---|---|
| `--paper` | `#f3ebdd` | `#1a1612` |
| `--paper-raised` | `#faf5e8` | `#231e18` |
| `--ink` | `#2c2319` | `#e8dbc3` |
| `--ink-soft` | `#6b5740` | `#a89478` |
| `--rust` | `#b5542b` | `#c97a4f` |
| `--teal` | `#4f7579` | `#6a9a9e` |
| `--amber` | `#c19024` | `#d4a83a` |
| `--danger` | `#a33a2a` | `#c95a4a` |
| `--border` | `#d9c9ab` | `#3a3028` |

Dark mode inverts the paper/ink relationship and lifts accent colors for contrast. Warm tones carry through — no cold grays.

### Typography

- **Newsreader** (Google Fonts) — headings, entity names, narrative text. The paperback feel.
- **JetBrains Mono** (Google Fonts) — chapter numbers, status codes, metadata, Workshop data. The tool contrast.
- **System sans-serif** — UI chrome only (tab labels, buttons, nav). Invisible.

Type scale (mobile):

| Role | Font | Size/Weight |
|---|---|---|
| Page title | Newsreader | 22px/600 |
| Card title | Newsreader | 17px/500 |
| Body | Newsreader | 15px/400 |
| Caption/meta | JetBrains Mono | 12px/400 |
| Status badge | JetBrains Mono | 10px/700 uppercase |

### Spacing

4px base rhythm. Most gaps: 8/12/16/24px. Cards: 16px padding. Page margins: 20px.

## Explore Mode

### Header

Compact single-line header:
- Left: book title (truncated) in Newsreader italic
- Center: current chapter pill (e.g., "Ch 14") — tappable to open pull-up sheet
- Right: overflow menu (three dots) containing Workshop, Settings, Chat

### Bottom Navigation

4-tab bar pinned to bottom with safe-area inset:
- Characters (user icon)
- Locations (map-pin icon)
- Arcs (git-branch icon)
- Map (compass icon)

Active tab: rust color with dot indicator. Inactive: ink-soft. Icons are simple line-art, 20px.

### Pull-Up Chapter Sheet

Replaces the current chapter selector for Explore. Navigation-only — no analysis controls.

Three snap points:
- **Peek** — just the current chapter title and a drag handle. Always visible above bottom nav.
- **Half** — scrollable chapter list showing title, page count, snapshot indicator.
- **Full** — full-screen chapter list with search/filter.

Tapping a chapter navigates to it and collapses the sheet. No analyze buttons, no range editing — that's Workshop territory.

### Content Tabs

**Characters tab:**
- Compact cards: avatar circle (initials), name (Newsreader 17px), role caption (JetBrains Mono 12px)
- Status dot: green (alive), red (dead), gray (unknown), amber (uncertain)
- Importance badge: rust background, white text (MAJOR/MINOR/MENTIONED)
- Tap to expand inline: relationships, last seen chapter, description
- "Last seen: Ch 12" as tappable link that jumps to that chapter

**Locations tab:**
- Same compact card pattern
- Shows "Current" badge for locations in the active chapter
- Inline expand shows description, associated characters, chapter appearances

**Arcs tab:**
- Horizontal progress bars with Newsreader labels
- Status chips: ACTIVE (teal), RESOLVED (ink-soft), DORMANT (amber)
- Tap to expand: description, key events, involved characters

**Map tab:**
- Existing map functionality, restyled with Tactile Paperback tokens

### Recap Strip

Below the header, a single-line strip:
- "Previously..." in Newsreader italic, followed by a one-line summary of the last chapter
- Tap to expand into a full recap card with key events

## Workshop Mode

Full-screen overlay that slides up from the bottom. Close button (X) in top-left returns to Explore.

### Workshop Header

- "Workshop" label in Newsreader
- Book title context below in JetBrains Mono 12px
- Close button (X) top-left

### Workshop Tabs

5 tabs across the top: Chapters / Structure / Entities / Library / Settings

**Chapters tab:**
- "Up next" action strip at top: next unanalyzed chapter with prominent "Analyze" button
- Range bar showing analyzed vs remaining chapters
- Dense chapter rows with JetBrains Mono status codes: CUR (current), SNAP (has snapshot), NEXT (queued), EXCL (excluded)
- Bottom toolbar: "Process all remaining" and "Rebuild" bulk actions
- All analysis controls live here — analyze, rebuild, delete snapshots, mark ranges

**Structure tab:**
- Multi-book series editor
- Book cards with chapter range sliders (start/end)
- Stale detection warnings with inline "Re-group" actions
- Exclusion list management
- Process banner at bottom showing background analysis progress

**Entities tab:**
- Entity reconciliation interface
- Merge/split proposals with accept/reject
- Manual entity editing

**Library tab:**
- Book list with gradient-generated covers (deterministic from title hash)
- Current book highlighted with pale background
- Reading progress bars and snapshot counts per book
- "Import EPUB" floating action button (bottom-right)
- Search bar at top

**Settings tab:**
- AI provider configuration
- Model selection
- API key management
- Theme toggle (light/dark)

## Motion & Micro-interactions

**Pull-up sheet:**
- Spring physics drag: `transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)`
- Backdrop dims to `rgba(0,0,0,0.3)` as sheet rises

**Page transitions:**
- Tab switches: horizontal slide (120ms ease-out), content fades in staggered (40ms delay per card)
- Explore to Workshop: sheet slides up from bottom (250ms). Workshop to Explore: slides back down.

**Card interactions:**
- Tap to expand: height animation (200ms ease)
- Long-press for full detail modal (haptic feedback on Android via Capacitor)

**Feedback:**
- Analyze button: pulse animation while processing, checkmark morph on completion
- Status badges: fade-in on snapshot completion (150ms)
- Pull-to-refresh: subtle paper-texture ripple from touch point

**What we skip:**
No parallax, no 3D transforms, no particle effects. Motion serves clarity — every animation should feel like turning a page.

**Implementation:** CSS transitions for most things. Framer Motion only if needed for gesture-driven drag (pull-up sheet). Minimal JS animation budget.

## Component Inventory

### New Components

| Component | Purpose |
|---|---|
| `BottomNav.tsx` | 4-tab bar (Characters / Locations / Arcs / Map) |
| `PullUpSheet.tsx` | Draggable chapter sheet with three snap points |
| `ExploreHeader.tsx` | Book title, chapter context, overflow menu |
| `WorkshopScreen.tsx` | Full-screen overlay with 5-tab layout |
| `BookCoverGradient.tsx` | Deterministic gradient covers from title hash |

### Refactored Components

| Component | Changes |
|---|---|
| `CharacterCard.tsx` | Restyle to Tactile Paperback tokens, add inline expand |
| `ChapterSelector.tsx` | Split: navigation-only for PullUpSheet, full power for Workshop/Chapters |
| `page.tsx` | Decompose 2485-line monolith into separate components |

### Retired

- Current sidebar layout (replaced by bottom nav)
- Current top tab bar (replaced by bottom nav)
- Current snapshot navigator (absorbed into PullUpSheet)

### File Structure

```
components/
  explore/        -- BottomNav, ExploreHeader, PullUpSheet
  workshop/       -- WorkshopScreen, WorkshopChapters, WorkshopStructure, WorkshopLibrary
  cards/          -- CharacterCard, LocationCard, ArcCard (restyled)
  ui/             -- BookCoverGradient, StatusBadge, shared primitives
```

## Technical Approach

- Tailwind CSS variables for all palette tokens (extend `tailwind.config.js`)
- Google Fonts via `next/font/google` for Newsreader and JetBrains Mono
- No new dependencies except possibly Framer Motion for pull-up sheet gesture
- Desktop: same components, bottom nav moves to sidebar, cards flow into grid. Mobile-first does not mean mobile-only.
