import type { AnalysisResult, Character, LocationInfo, NarrativeArc, Snapshot } from '@/types';
import { buildLocationAliasMap, resolveLocationName } from '@/lib/resolve-locations';

export interface AggregatedCharacter {
  character: Character;
  isCurrent: boolean;
  firstSeenIndex: number;
  lastSeenIndex: number;
  snapshotCount: number;
}

export interface AggregatedLocation {
  location: LocationInfo;
  isCurrent: boolean;
  firstSeenIndex: number;
  lastSeenIndex: number;
  snapshotCount: number;
}

export interface AggregatedArc {
  arc: NarrativeArc;
  isCurrent: boolean;
  firstSeenIndex: number;
  lastSeenIndex: number;
  snapshotCount: number;
}

const IMPORTANCE_ORDER: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

function norm(s: string) { return s.toLowerCase().trim(); }

export function aggregateEntities(
  snapshots: Snapshot[],
  latestResult: AnalysisResult,
  prebuiltAliasMap?: Map<string, string>,
): { characters: AggregatedCharacter[]; locations: AggregatedLocation[]; arcs: AggregatedArc[] } {
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);

  // -- Characters --
  // Resolve old snapshot names to canonical current names via aliases
  const charAliasToCanonical = new Map<string, string>();
  for (const c of latestResult.characters) {
    const canonical = norm(c.name);
    charAliasToCanonical.set(canonical, canonical);
    for (const alias of c.aliases ?? []) {
      charAliasToCanonical.set(norm(alias), canonical);
    }
  }

  const charMap = new Map<string, AggregatedCharacter>();
  for (const snap of sorted) {
    for (const c of snap.result.characters) {
      const rawKey = norm(c.name);
      const key = charAliasToCanonical.get(rawKey) ?? rawKey;
      const existing = charMap.get(key);
      if (existing) {
        existing.character = c;
        existing.lastSeenIndex = snap.index;
        existing.snapshotCount++;
      } else {
        charMap.set(key, {
          character: c,
          isCurrent: false,
          firstSeenIndex: snap.index,
          lastSeenIndex: snap.index,
          snapshotCount: 1,
        });
      }
    }
  }
  const currentCharKeys = new Set(latestResult.characters.map((c) => norm(c.name)));
  for (const [key, entry] of charMap) {
    if (currentCharKeys.has(key)) {
      entry.isCurrent = true;
      entry.character = latestResult.characters.find((c) => norm(c.name) === key)!;
    }
  }
  // Add any current characters not found in snapshots
  for (const c of latestResult.characters) {
    if (!charMap.has(norm(c.name))) {
      charMap.set(norm(c.name), {
        character: c,
        isCurrent: true,
        firstSeenIndex: -1,
        lastSeenIndex: -1,
        snapshotCount: 0,
      });
    }
  }

  // -- Locations --
  // Resolve old snapshot names to canonical current names via aliases
  const locAliasToCanonical = new Map<string, string>();
  for (const l of latestResult.locations ?? []) {
    const canonical = norm(l.name);
    locAliasToCanonical.set(canonical, canonical);
    for (const alias of l.aliases ?? []) {
      locAliasToCanonical.set(norm(alias), canonical);
    }
  }

  const locMap = new Map<string, AggregatedLocation>();
  for (const snap of sorted) {
    for (const l of snap.result.locations ?? []) {
      const rawKey = norm(l.name);
      const key = locAliasToCanonical.get(rawKey) ?? rawKey;
      const existing = locMap.get(key);
      if (existing) {
        existing.location = l;
        existing.lastSeenIndex = snap.index;
        existing.snapshotCount++;
      } else {
        locMap.set(key, {
          location: l,
          isCurrent: false,
          firstSeenIndex: snap.index,
          lastSeenIndex: snap.index,
          snapshotCount: 1,
        });
      }
    }
  }
  const currentLocKeys = new Set((latestResult.locations ?? []).map((l) => norm(l.name)));
  for (const [key, entry] of locMap) {
    if (currentLocKeys.has(key)) {
      entry.isCurrent = true;
      entry.location = (latestResult.locations ?? []).find((l) => norm(l.name) === key)!;
    }
  }
  for (const l of latestResult.locations ?? []) {
    if (!locMap.has(norm(l.name))) {
      locMap.set(norm(l.name), {
        location: l,
        isCurrent: true,
        firstSeenIndex: -1,
        lastSeenIndex: -1,
        snapshotCount: 0,
      });
    }
  }

  // -- Character-referenced locations --
  // Characters may reference locations not in any result.locations array.
  const realLocKeys = new Set(locMap.keys());
  const aliasMap = prebuiltAliasMap ?? buildLocationAliasMap(sorted, latestResult.locations);
  const resolveOrRaw = (name: string) => resolveLocationName(name, aliasMap) ?? name;

  for (const snap of sorted) {
    for (const c of snap.result.characters) {
      const raw = c.currentLocation?.trim();
      if (!raw || raw === 'Unknown') continue;
      const canonical = resolveOrRaw(raw);
      const key = norm(canonical);
      if (realLocKeys.has(key)) continue;
      const existing = locMap.get(key);
      if (existing) {
        existing.lastSeenIndex = snap.index;
        existing.snapshotCount++;
      } else {
        locMap.set(key, {
          location: { name: canonical, description: '' },
          isCurrent: false,
          firstSeenIndex: snap.index,
          lastSeenIndex: snap.index,
          snapshotCount: 1,
        });
      }
    }
  }
  for (const c of latestResult.characters) {
    const raw = c.currentLocation?.trim();
    if (!raw || raw === 'Unknown') continue;
    const canonical = resolveOrRaw(raw);
    const key = norm(canonical);
    if (realLocKeys.has(key)) continue;
    const existing = locMap.get(key);
    if (existing) {
      existing.isCurrent = true;
    } else {
      locMap.set(key, {
        location: { name: canonical, description: '' },
        isCurrent: true,
        firstSeenIndex: -1,
        lastSeenIndex: -1,
        snapshotCount: 0,
      });
    }
  }

  // -- Arcs --
  const arcMap = new Map<string, AggregatedArc>();
  for (const snap of sorted) {
    for (const a of snap.result.arcs ?? []) {
      const key = norm(a.name);
      const existing = arcMap.get(key);
      if (existing) {
        existing.arc = a;
        existing.lastSeenIndex = snap.index;
        existing.snapshotCount++;
      } else {
        arcMap.set(key, {
          arc: a,
          isCurrent: false,
          firstSeenIndex: snap.index,
          lastSeenIndex: snap.index,
          snapshotCount: 1,
        });
      }
    }
  }
  const currentArcKeys = new Set((latestResult.arcs ?? []).map((a) => norm(a.name)));
  for (const [key, entry] of arcMap) {
    if (currentArcKeys.has(key)) {
      entry.isCurrent = true;
      entry.arc = (latestResult.arcs ?? []).find((a) => norm(a.name) === key)!;
    }
  }
  for (const a of latestResult.arcs ?? []) {
    if (!arcMap.has(norm(a.name))) {
      arcMap.set(norm(a.name), {
        arc: a,
        isCurrent: true,
        firstSeenIndex: -1,
        lastSeenIndex: -1,
        snapshotCount: 0,
      });
    }
  }

  // Sort: current first (characters by importance then name, others by name), then historical by lastSeenIndex desc
  const characters = [...charMap.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isCurrent) {
      const ia = IMPORTANCE_ORDER[a.character.importance] ?? 0;
      const ib = IMPORTANCE_ORDER[b.character.importance] ?? 0;
      if (ia !== ib) return ib - ia;
      return a.character.name.localeCompare(b.character.name);
    }
    return b.lastSeenIndex - a.lastSeenIndex;
  });

  const locations = [...locMap.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isCurrent) return a.location.name.localeCompare(b.location.name);
    return b.lastSeenIndex - a.lastSeenIndex;
  });

  const arcs = [...arcMap.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isCurrent) return a.arc.name.localeCompare(b.arc.name);
    return b.lastSeenIndex - a.lastSeenIndex;
  });

  return { characters, locations, arcs };
}
