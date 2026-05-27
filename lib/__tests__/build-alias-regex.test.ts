import { describe, it, expect } from 'vitest';
import { buildAliasRegex, STOPWORDS } from '@/lib/retrieve-context';
import type { EntityRecord } from '@/lib/entity-graph';
import type { Character } from '@/types';

function rec(name: string, aliases: string[] = []): EntityRecord {
  return {
    id: `c::character::${name.toLowerCase()}`,
    containerId: 'c',
    type: 'character',
    canonicalName: name,
    canonicalLower: name.toLowerCase(),
    lastSeenOrder: 0,
    payload: {
      name,
      aliases,
      importance: 'secondary',
      status: 'alive',
      lastSeen: '',
      currentLocation: '',
      description: '',
      relationships: [],
      recentEvents: '',
    } as Character,
  };
}

describe('buildAliasRegex', () => {
  it('returns null for empty input', () => {
    expect(buildAliasRegex([])).toBeNull();
  });

  it('matches exact names case-insensitively at word boundaries', () => {
    const re = buildAliasRegex([rec('Rand')])!;
    expect('rand walked away'.match(re)).not.toBeNull();
    expect('Rand walked away'.match(re)).not.toBeNull();
    expect('Brandon walked away'.match(re)).toBeNull();  // word boundary
  });

  it('matches aliases', () => {
    const re = buildAliasRegex([rec('Matrim Cauthon', ['Mat'])])!;
    expect('Mat grinned'.match(re)).not.toBeNull();
    expect('Matrim grinned'.match(re)).toBeNull();   // 'Matrim' alone isn't an alias
    expect('Matrim Cauthon grinned'.match(re)).not.toBeNull();
  });

  it('sorts longest-first so multi-word names win over their prefixes', () => {
    const re = buildAliasRegex([rec('Matrim Cauthon', ['Mat'])])!;
    const m = re.exec('Matrim Cauthon was here');
    expect(m![1]).toBe('Matrim Cauthon');     // not 'Mat'
  });

  it('filters aliases shorter than 3 chars', () => {
    const re = buildAliasRegex([rec('Al')]);
    expect(re).toBeNull();  // Al is length 2 → filtered → no aliases left → null
  });

  it('filters stopwords (titles that collide with common English)', () => {
    expect(STOPWORDS.has('lord')).toBe(true);
    expect(STOPWORDS.has('father')).toBe(true);
    const re = buildAliasRegex([rec('Father', ['Lord'])]);
    expect(re).toBeNull();
  });

  it('escapes regex metacharacters in names', () => {
    const re = buildAliasRegex([rec('M.O.D.O.K.')])!;
    expect('M.O.D.O.K. attacks'.match(re)).not.toBeNull();
    expect('MaOaDaOaKa attacks'.match(re)).toBeNull();
  });
});
