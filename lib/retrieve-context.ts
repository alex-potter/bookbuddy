// lib/retrieve-context.ts
import type { Character, LocationInfo } from '@/types';
import type { EntityRecord, EntityType, SketchEntry } from './entity-graph';

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
