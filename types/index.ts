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

export interface LocationInfo {
  name: string;
  arc?: string;          // narrative arc / storyline this location belongs to
  description: string;   // 1–2 sentence description of the place
  recentEvents?: string; // what happened at this location in the most recent chapter
}

export interface AnalysisResult {
  characters: Character[];
  locations?: LocationInfo[];
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
