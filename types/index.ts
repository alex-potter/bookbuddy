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

export interface AnalysisResult {
  characters: Character[];
  summary: string;
}

export interface Snapshot {
  index: number;         // chapter index (0-based)
  result: AnalysisResult;
}

export interface LocationPin {
  x: number;  // percentage of image width  (0–100)
  y: number;  // percentage of image height (0–100)
}

export interface MapState {
  imageDataUrl: string;
  pins: Record<string, LocationPin>;  // location name → coordinates
}
