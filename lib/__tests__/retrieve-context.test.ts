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
