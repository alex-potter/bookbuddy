// lib/retrieve-context.ts
import type { Character, LocationInfo } from '@/types';
import type { EntityRecord } from './entity-graph';

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
