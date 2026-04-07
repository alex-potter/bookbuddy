export interface CalibreBook {
  id: number;
  title: string;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  formats: string[];
  hasCover: boolean;
}

export interface EbookChapter {
  id: string;
  title: string;
  text: string;
  order: number;
  bookIndex?: number;   // which book in an omnibus (0-based); undefined for standalone
  bookTitle?: string;   // title of that book within the omnibus
  preview?: string;     // first meaningful line of content (~80 chars)
  contentType?: 'story' | 'front-matter' | 'back-matter' | 'structural';
}

export interface ParsedEbook {
  title: string;
  author: string;
  chapters: EbookChapter[];
  books?: string[];  // individual book titles if omnibus detected
}

export interface CharacterRelationship {
  character: string;
  relationship: string;
}

export interface Character {
  name: string;
  aliases: string[];
  importance: 'main' | 'secondary' | 'minor';
  status: 'alive' | 'dead' | 'unknown' | 'uncertain';
  lastSeen: string;
  currentLocation: string;
  description: string;
  relationships: CharacterRelationship[];
  recentEvents: string;
}

export interface LocationRelationship {
  location: string;      // the related location name
  relationship: string;  // e.g. "contains", "part of", "adjacent to", "accessible via"
}

export interface LocationInfo {
  name: string;
  aliases?: string[];                    // alternative names (e.g. "Ceres" for "Ceres Station")
  arc?: string;                          // narrative arc / storyline this location belongs to
  parentLocation?: string;               // name of the containing/parent location
  description: string;                   // 1–2 sentence description of the place
  recentEvents?: string;                 // what happened at this location in the most recent chapter
  relationships?: LocationRelationship[]; // how this place relates to other known places
}

export interface NarrativeArc {
  name: string;
  status: 'active' | 'resolved' | 'dormant';
  characters: string[];   // character names involved
  summary: string;        // current state of this arc
}

export interface ParentArc {
  name: string;
  children: string[];  // child arc names, ordered
  summary: string;     // AI-generated summary of the grouped theme
}

export interface BookDefinition {
  index: number;              // 0-based book order in series
  title: string;              // detected or user-provided book title
  chapterStart: number;       // first chapter order (inclusive)
  chapterEnd: number;         // last chapter order (inclusive)
  excludedChapters: number[]; // chapter orders excluded within this book
  confirmed: boolean;         // user has reviewed/confirmed this book's bounds
  excluded?: boolean;         // entire book excluded from analysis and sidebar
  parentArcs?: ParentArc[];   // per-book thematic arc groupings
  arcGroupingHash?: string;   // hash of bounds at last arc grouping, for staleness detection
}

export interface SeriesDefinition {
  books: BookDefinition[];
  seriesArcs?: ParentArc[];   // series-wide thematic arc groupings
  unassignedChapters: number[]; // chapter orders not belonging to any book (auto-derived)
}

export type BookFilter =
  | { mode: 'all' }
  | { mode: 'books'; indices: number[] };

export interface AnalysisResult {
  characters: Character[];
  locations?: LocationInfo[];
  arcs?: NarrativeArc[];
  summary: string;
}

export interface Snapshot {
  index: number;         // chapter index (0-based)
  result: AnalysisResult;
  model?: string;        // model used to analyze this chapter (e.g. "qwen2.5:14b", "claude-haiku-4-5")
  appVersion?: string;   // BookBuddy version that processed this chapter (e.g. "0.1.0")
}

export interface LocationPin {
  x: number;  // percentage of image width  (0–100)
  y: number;  // percentage of image height (0–100)
}

export interface QueueJob {
  id: string;
  title: string;
  author: string;
  status: 'waiting' | 'running' | 'done' | 'error';
  progress?: { current: number; total: number; chapterTitle?: string };
  error?: string;
}

export interface MapState {
  imageDataUrl: string;
  pins: Record<string, LocationPin>;  // location name → coordinates
  locationImage?: string;             // Locations-tab display-only map image
  locationLabel?: string;
}

export interface PinUpdates {
  renames?: Record<string, string>;  // oldName → newName
  deletes?: string[];
}

export interface BookMeta {
  chapters: Array<{
    id: string;
    title: string;
    order: number;
    bookIndex?: number;
    bookTitle?: string;
    preview?: string;
    contentType?: 'story' | 'front-matter' | 'back-matter' | 'structural';
  }>;
  books?: string[];
}

export interface StoredBookState {
  lastAnalyzedIndex: number; // -2 = meta only, -1 = series carry-forward, ≥0 = analyzed
  result: AnalysisResult;
  snapshots: Snapshot[];
  excludedBooks?: number[];
  excludedChapters?: number[];
  chapterRange?: { start: number; end: number };
  bookMeta?: BookMeta;
  readingBookmark?: number;
  parentArcs?: ParentArc[];
  series?: SeriesDefinition;  // NEW
}

export interface SavedBookEntry {
  title: string;
  author: string;
  lastAnalyzedIndex: number;
  chapterCount?: number;
}

export interface BookBuddyExport {
  version: 2;
  title: string;
  author: string;
  state: StoredBookState;
  mapState: MapState | null;
}
