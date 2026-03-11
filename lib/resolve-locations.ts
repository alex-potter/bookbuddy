import type { Character, Snapshot } from '@/types';

/**
 * Build a map from any known location name / alias (lowercased) → canonical name.
 * The canonical name is the longest form seen across all snapshot location entries.
 * Use this to normalise location strings read from older snapshots where the AI
 * may have used a short alias before the full name was established.
 */
export function buildLocationAliasMap(snapshots: Snapshot[]): Map<string, string> {
  // group key (lowercased) → canonical name (longest form)
  const canonicalByKey = new Map<string, string>();

  function norm(s: string) { return s.toLowerCase().trim(); }

  function register(names: string[]) {
    // Find if any name is already known
    let existingKey: string | undefined;
    for (const n of names) {
      if (canonicalByKey.has(norm(n))) { existingKey = norm(n); break; }
    }
    // Canonical = longest name in this cluster
    const canonical = names.reduce((a, b) => a.length >= b.length ? a : b);
    const allKeys = [...new Set(names.map(norm))];
    if (existingKey) {
      // Merge: update all keys to point to the longer canonical
      const existing = canonicalByKey.get(existingKey)!;
      const merged = canonical.length >= existing.length ? canonical : existing;
      for (const k of allKeys) canonicalByKey.set(k, merged);
      // Also update any keys already pointing to the old canonical
      for (const [k, v] of canonicalByKey) {
        if (v === existing && merged !== existing) canonicalByKey.set(k, merged);
      }
    } else {
      for (const k of allKeys) canonicalByKey.set(k, canonical);
    }
  }

  for (const snap of snapshots) {
    for (const loc of snap.result.locations ?? []) {
      if (!loc.name) continue;
      register([loc.name, ...(loc.aliases ?? [])]);
    }
  }

  return canonicalByKey;
}

/** Resolve a location string to its canonical name using the alias map. */
export function resolveLocationName(name: string | undefined, aliasMap: Map<string, string>): string | undefined {
  if (!name) return name;
  return aliasMap.get(name.toLowerCase().trim()) ?? name;
}

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
