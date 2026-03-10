import type { Character, Snapshot } from '@/types';

/**
 * For each character whose currentLocation is absent or 'Unknown',
 * scan backwards through snapshots to find their last confirmed location.
 * Returns a new array; characters with known locations are returned unchanged.
 */
export function withResolvedLocations(
  characters: Character[],
  snapshots: Snapshot[],
): Character[] {
  if (characters.length === 0 || snapshots.length === 0) return characters;

  // Sort newest-first so we find the most recent known location quickly
  const sorted = [...snapshots].sort((a, b) => b.index - a.index);

  return characters.map((c) => {
    const loc = c.currentLocation?.trim();
    if (loc && loc !== 'Unknown') return c;

    for (const snap of sorted) {
      const match = snap.result.characters.find((sc) => sc.name === c.name);
      if (match) {
        const ml = match.currentLocation?.trim();
        if (ml && ml !== 'Unknown') return { ...c, currentLocation: ml };
      }
    }
    return c;
  });
}
