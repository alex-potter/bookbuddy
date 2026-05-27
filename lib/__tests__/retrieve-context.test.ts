import { describe, it, expect } from 'vitest';
import { matchAliasesInText, buildAliasRegex } from '@/lib/retrieve-context';
import type { EntityRecord } from '@/lib/entity-graph';
import type { Character } from '@/types';

function rec(name: string, aliases: string[] = [], id?: string): EntityRecord {
  return {
    id: id ?? `c::character::${name.toLowerCase()}`,
    containerId: 'c',
    type: 'character',
    canonicalName: name,
    canonicalLower: name.toLowerCase(),
    lastSeenOrder: 0,
    payload: {
      name, aliases,
      importance: 'secondary', status: 'alive',
      lastSeen: '', currentLocation: '', description: '',
      relationships: [], recentEvents: '',
    } as Character,
  };
}

describe('matchAliasesInText', () => {
  it('returns IDs of records whose names appear in the text', () => {
    const records = [rec('Rand'), rec('Mat'), rec('Egwene')];
    const ids = matchAliasesInText(records, 'Rand and Egwene walked through the village');
    expect(ids.sort()).toEqual(['c::character::egwene', 'c::character::rand']);
  });

  it('returns empty array when nothing matches', () => {
    const records = [rec('Rand'), rec('Mat')];
    const ids = matchAliasesInText(records, 'A different story entirely.');
    expect(ids).toEqual([]);
  });

  it('deduplicates: one mention per record even if mentioned multiple times', () => {
    const records = [rec('Rand')];
    const ids = matchAliasesInText(records, 'Rand looked at Rand and thought of Rand.');
    expect(ids).toEqual(['c::character::rand']);
  });

  it('resolves aliases back to the canonical record id', () => {
    const records = [rec('Matrim Cauthon', ['Mat'])];
    const ids = matchAliasesInText(records, 'Mat grinned.');
    expect(ids).toEqual([records[0].id]);
  });

  it('returns empty array when buildAliasRegex returns null', () => {
    // No usable aliases (all stopwords)
    const records = [rec('Father'), rec('Lord')];
    expect(buildAliasRegex(records)).toBeNull();
    expect(matchAliasesInText(records, 'Father Lord passed by')).toEqual([]);
  });
});

import { trimSketch, estimateSketchEntrySize, estimateCharSize, RECENCY_WINDOW } from '@/lib/retrieve-context';

function recImp(name: string, importance: 'main' | 'secondary' | 'minor', lastSeen: number, aliases: string[] = []): EntityRecord {
  return {
    ...rec(name, aliases),
    lastSeenOrder: lastSeen,
    importance,
  };
}

describe('trimSketch', () => {
  it('returns empty when budget is 0', () => {
    const out = trimSketch([recImp('A', 'main', 0)], 0);
    expect(out).toEqual([]);
  });

  it('returns all entries when budget exceeds total size', () => {
    const out = trimSketch([recImp('Rand', 'main', 0), recImp('Mat', 'main', 0)], 1_000_000);
    expect(out.map(e => e.name).sort()).toEqual(['Mat', 'Rand']);
  });

  it('keeps highest-importance first when trimming', () => {
    const records = [
      recImp('Minor1', 'minor', 0),
      recImp('Main1', 'main', 0),
      recImp('Secondary1', 'secondary', 0),
    ];
    // Budget enough for ~2 entries
    const oneCost = estimateSketchEntrySize({ name: 'Main1' });
    const out = trimSketch(records, oneCost * 2 + 5);
    expect(out.map(e => e.name)).toContain('Main1');
    expect(out.map(e => e.name)).toContain('Secondary1');
    expect(out.map(e => e.name)).not.toContain('Minor1');
  });

  it('breaks importance ties by recency DESC', () => {
    const records = [
      recImp('Old', 'main', 0),
      recImp('Recent', 'main', 100),
    ];
    const oneCost = estimateSketchEntrySize({ name: 'Recent' });
    const out = trimSketch(records, oneCost + 2);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Recent');
  });

  it('includes aliases in the sketch entry when present', () => {
    const out = trimSketch([recImp('Matrim Cauthon', 'main', 0, ['Mat'])], 1_000_000);
    expect(out[0].aliases).toEqual(['Mat']);
  });

  it('omits aliases field when the record has none', () => {
    const out = trimSketch([recImp('Rand', 'main', 0)], 1_000_000);
    expect(out[0].aliases).toBeUndefined();
  });
});

describe('RECENCY_WINDOW', () => {
  it('uses different windows per entity type', () => {
    expect(RECENCY_WINDOW.character).toBeGreaterThan(0);
    expect(RECENCY_WINDOW.location).toBeGreaterThan(RECENCY_WINDOW.character);
    expect(RECENCY_WINDOW.arc).toBe(Infinity);
  });
});
