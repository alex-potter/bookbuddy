// lib/entity-graph.ts
import type { Character, LocationInfo, NarrativeArc } from '@/types';
import { openDB, ENTITY_STORE } from './book-storage';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EntityType = 'character' | 'location' | 'arc';

export interface EntityRecord {
  id: string;                // `${containerId}::${type}::${canonicalLower}`
  containerId: string;       // indexed
  type: EntityType;
  canonicalName: string;
  canonicalLower: string;
  lastSeenOrder: number;
  importance?: 'main' | 'secondary' | 'minor';
  payload: Character | LocationInfo | NarrativeArc;
}

export interface SketchEntry {
  name: string;
  aliases?: string[];
}

export interface RetrievedContext<T> {
  full: T[];
  sketch: SketchEntry[];
  stats: {
    rosterSize: number;
    mentionedCount: number;
    recentCount: number;
    sketchTrimmed: number;
  };
}

export interface MentionedNames {
  characters: Set<string>;
  locations: Set<string>;
  arcs: Set<string>;
}

// ─── Key helpers ────────────────────────────────────────────────────────────

export function keyFor(containerId: string, type: EntityType, canonicalName: string): string {
  return `${containerId}::${type}::${canonicalName.toLowerCase().trim()}`;
}

export function containerKey(title: string, author: string): string {
  return `${title}::${author}`;
}

// Re-export for consumers that need the store name
export { openDB, ENTITY_STORE };
