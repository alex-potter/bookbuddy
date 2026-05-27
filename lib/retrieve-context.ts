// lib/retrieve-context.ts
import type { Character, LocationInfo, NarrativeArc } from '@/types';
import type { EntityRecord, EntityType, RetrievedContext, SketchEntry } from './entity-graph';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Lowercase tokens we never want to treat as character/location aliases.
 * These tend to appear in chapter text constantly and would cause floods
 * of false-positive mentions.
 */
export const STOPWORDS = new Set<string>([
  'the', 'lord', 'lady', 'king', 'queen', 'sir',
  'father', 'mother', 'brother', 'sister', 'son', 'daughter',
  'captain', 'master', 'mistress', 'man', 'woman', 'boy', 'girl',
  'one', 'two', 'three',
]);

const MAX_ALIASES_PER_PATTERN = 5000;
const MAX_PATTERN_BYTES = 1_000_000;

// ─── Regex building ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasesOf(rec: EntityRecord): string[] {
  // Arcs have no `aliases` field; LocationInfo's is optional.
  const payload = rec.payload as Partial<Character & LocationInfo>;
  return payload.aliases ?? [];
}

/**
 * Compile a single word-boundary alternation matching every canonical name +
 * alias in the input records. Returns null if no usable aliases survive
 * stopword/length filtering.
 *
 * Sorts longest-first so multi-word names match before their prefixes.
 */
export function buildAliasRegex(records: EntityRecord[]): RegExp | null {
  const aliasMap = new Map<string, EntityRecord>();
  for (const r of records) {
    for (const alias of [r.canonicalName, ...aliasesOf(r)]) {
      const lower = alias.toLowerCase().trim();
      if (lower.length < 3) continue;
      if (STOPWORDS.has(lower)) continue;
      if (!aliasMap.has(lower)) aliasMap.set(lower, r);
    }
  }

  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  if (aliases.length === 0) return null;
  if (aliases.length > MAX_ALIASES_PER_PATTERN) aliases.length = MAX_ALIASES_PER_PATTERN;

  const buildSource = (alts: string[]) =>
    `(?<!\\w)(${alts.map(escapeRegex).join('|')})(?!\\w)`;

  let source = buildSource(aliases);
  if (source.length > MAX_PATTERN_BYTES) {
    // Trim further to fit byte cap; preserves longest aliases (highest signal).
    while (source.length > MAX_PATTERN_BYTES && aliases.length > 0) {
      aliases.pop();
      source = buildSource(aliases);
    }
    if (aliases.length === 0) return null;
  }

  try {
    return new RegExp(source, 'giu');
  } catch (err) {
    console.warn('[entity-graph] regex compile failed, halving alias set', err);
    aliases.length = Math.floor(aliases.length / 2);
    if (aliases.length === 0) return null;
    return new RegExp(`(?<!\\w)(${aliases.map(escapeRegex).join('|')})(?!\\w)`, 'giu');
  }
}

// ─── Mention detection ──────────────────────────────────────────────────────

/**
 * Scan chapter text for any alias of any record. Returns a deduplicated list
 * of record IDs whose name or alias appears in the text.
 */
export function matchAliasesInText(records: EntityRecord[], text: string): string[] {
  // Rebuild the alias→record map (mirror of what buildAliasRegex did internally).
  const aliasMap = new Map<string, EntityRecord>();
  for (const r of records) {
    for (const alias of [r.canonicalName, ...aliasesOf(r)]) {
      const lower = alias.toLowerCase().trim();
      if (lower.length < 3) continue;
      if (STOPWORDS.has(lower)) continue;
      if (!aliasMap.has(lower)) aliasMap.set(lower, r);
    }
  }

  const pattern = buildAliasRegex(records);
  if (!pattern) return [];

  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const matched = m[1].toLowerCase();
    const rec = aliasMap.get(matched);
    if (rec) hits.add(rec.id);
  }
  return [...hits];
}

// ─── Sketch trimming + size estimators ──────────────────────────────────────

export const RECENCY_WINDOW: Record<EntityType, number> = {
  character: 5,
  location: 8,
  arc: Infinity,   // arcs are capped at ~8 already; always include
};

const IMPORTANCE_RANK: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

export function estimateSketchEntrySize(e: SketchEntry): number {
  // Format the LLM sees: "- Name [aliases: a, b]\n"
  const aliasPart = e.aliases?.length ? ` [aliases: ${e.aliases.join(', ')}]` : '';
  return 3 + e.name.length + aliasPart.length;   // "- " + name + aliases + "\n"
}

export function estimateCharSize<T>(items: T[]): number {
  // Conservative: serialize as JSON and measure. The actual prompt format is
  // shorter, but this is the right order of magnitude and is provider-agnostic.
  return JSON.stringify(items).length;
}

/**
 * Reduce a candidate list to fit within charBudget, preferring higher
 * importance and more-recently-seen entries.
 */
export function trimSketch(others: EntityRecord[], charBudget: number): SketchEntry[] {
  if (charBudget <= 0) return [];

  const sorted = [...others].sort((a, b) => {
    const ai = IMPORTANCE_RANK[a.importance ?? 'secondary'] ?? 2;
    const bi = IMPORTANCE_RANK[b.importance ?? 'secondary'] ?? 2;
    if (ai !== bi) return bi - ai;
    return b.lastSeenOrder - a.lastSeenOrder;
  });

  const kept: SketchEntry[] = [];
  let used = 0;
  for (const r of sorted) {
    const aliases = aliasesOf(r);
    const entry: SketchEntry = aliases.length
      ? { name: r.canonicalName, aliases }
      : { name: r.canonicalName };
    const cost = estimateSketchEntrySize(entry);
    if (used + cost > charBudget) break;
    kept.push(entry);
    used += cost;
  }
  return kept;
}

// ─── Top-level retrieval ────────────────────────────────────────────────────

import { getAllByContainer, rebuildEntityGraph } from './entity-graph';
import { loadBookState } from './book-storage';

/**
 * Per-chapter retrieval: returns the entities to send to the LLM, split into
 * a `full` tier (full payloads — mentioned in chapter text OR in recency window)
 * and a `sketch` tier (name + aliases only, budget-trimmed).
 */
export async function retrieveContext<T = unknown>(
  containerId: string,
  type: EntityType,
  chapterText: string,
  chapterOrder: number,
  charBudget: number,
): Promise<RetrievedContext<T>> {
  // Debug feature flag: bypass the graph entirely to compare behavior.
  const disabled = typeof localStorage !== 'undefined' &&
    typeof localStorage.getItem === 'function' &&
    localStorage.getItem('bookbuddy-disable-entity-graph') === '1';
  if (disabled) {
    return {
      full: [],
      sketch: [],
      stats: { rosterSize: 0, mentionedCount: 0, recentCount: 0, sketchTrimmed: 0 },
    };
  }

  let records = await getAllByContainer(containerId, type);

  // Lazy migration: if the graph is empty but the book has snapshots,
  // backfill from snapshots once. Subsequent calls hit the populated graph.
  if (records.length === 0) {
    const [title, author] = containerId.split('::');
    const state = await loadBookState(title, author);
    if (state?.snapshots?.length) {
      console.log(`[entity-graph] lazy backfill for container=${containerId} (${state.snapshots.length} snapshots)`);
      await rebuildEntityGraph(containerId, state.snapshots);
      records = await getAllByContainer(containerId, type);
    }
  }

  if (records.length === 0) {
    return {
      full: [],
      sketch: [],
      stats: { rosterSize: 0, mentionedCount: 0, recentCount: 0, sketchTrimmed: 0 },
    };
  }

  const mentionedIds = new Set(matchAliasesInText(records, chapterText));

  const window = RECENCY_WINDOW[type];
  const recentIds = new Set<string>();
  for (const r of records) {
    if (r.lastSeenOrder >= chapterOrder - window) recentIds.add(r.id);
  }

  const fullIds = new Set([...mentionedIds, ...recentIds]);
  const full: T[] = [];
  const others: EntityRecord[] = [];
  for (const r of records) {
    if (fullIds.has(r.id)) full.push(r.payload as T);
    else others.push(r);
  }

  const fullSize = estimateCharSize(full);
  const sketch = trimSketch(others, Math.max(0, charBudget - fullSize));

  // "recent" stat = recent AND NOT mentioned (the new info recency adds)
  let recentOnly = 0;
  for (const id of recentIds) if (!mentionedIds.has(id)) recentOnly++;

  return {
    full,
    sketch,
    stats: {
      rosterSize: records.length,
      mentionedCount: mentionedIds.size,
      recentCount: recentOnly,
      sketchTrimmed: others.length - sketch.length,
    },
  };
}

// ─── Prompt format helpers ──────────────────────────────────────────────────

/**
 * Format a RetrievedContext for inclusion in a prompt. Returns two blocks:
 *   - "fullBlock":   detailed entries the LLM should treat as known context
 *   - "sketchBlock": one-line entries the LLM should be aware exist (avoid
 *                    creating duplicates), without their detailed state
 */
export function formatCharContext(ctx: RetrievedContext<Character>): {
  fullBlock: string;
  sketchBlock: string;
} {
  const fullBlock = ctx.full
    .map(c => {
      const aliasStr = c.aliases?.length ? ` [aliases: ${c.aliases.join(', ')}]` : '';
      return `- ${c.name}${aliasStr} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`;
    })
    .join('\n');

  const sketchBlock = ctx.sketch
    .map(s => {
      const aliasStr = s.aliases?.length ? ` [aliases: ${s.aliases.join(', ')}]` : '';
      return `- ${s.name}${aliasStr}`;
    })
    .join('\n');

  return { fullBlock, sketchBlock };
}

export function formatLocContext(ctx: RetrievedContext<LocationInfo>): {
  fullBlock: string;
  sketchBlock: string;
} {
  const fullBlock = ctx.full
    .map(l => `- ${l.name}: ${l.description ?? '(no description yet)'}`)
    .join('\n');

  const sketchBlock = ctx.sketch
    .map(s => `- ${s.name}`)
    .join('\n');

  return { fullBlock, sketchBlock };
}

export function formatArcContext(ctx: RetrievedContext<NarrativeArc>): {
  fullBlock: string;
  sketchBlock: string;
} {
  const fullBlock = ctx.full
    .map(a => `- ${a.name} [${a.status}]: ${a.summary}`)
    .join('\n');

  const sketchBlock = ctx.sketch
    .map(s => `- ${s.name}`)
    .join('\n');

  return { fullBlock, sketchBlock };
}
