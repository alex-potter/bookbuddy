import { useMemo } from 'react';
import type { AnalysisResult, Character, Snapshot } from '@/types';
import { aggregateEntities } from '@/lib/aggregate-entities';
import type { AggregatedCharacter, AggregatedLocation, AggregatedArc } from '@/lib/aggregate-entities';
import { buildLocationAliasMap, resolveLocationName, withResolvedLocations, resolveCharacterLocationsToExtracted } from '@/lib/resolve-locations';

export interface LocationGroup {
  location: string;
  characters: Character[];
  description?: string;
}

export interface DerivedEntities {
  aggregated: {
    characters: AggregatedCharacter[];
    locations: AggregatedLocation[];
    arcs: AggregatedArc[];
  };
  locationAliasMap: Map<string, string>;
  resolvedCharacters: Character[];
  locationGroups: LocationGroup[];
  arcChapterMap: Map<string, number[]>;
}

export function useDerivedEntities(
  snapshots: Snapshot[],
  currentResult: AnalysisResult | null,
): DerivedEntities {
  return useMemo(() => {
    const empty: DerivedEntities = {
      aggregated: { characters: [], locations: [], arcs: [] },
      locationAliasMap: new Map(),
      resolvedCharacters: [],
      locationGroups: [],
      arcChapterMap: new Map(),
    };
    if (!currentResult) return empty;

    const sorted = [...snapshots].sort((a, b) => a.index - b.index);

    // 1. Single canonical alias map
    const locationAliasMap = buildLocationAliasMap(sorted, currentResult.locations);
    const resolveLoc = (name: string | undefined) =>
      resolveLocationName(name?.trim(), locationAliasMap) ?? name?.trim();

    // 2. Resolved characters (backfill unknown locations)
    const resolvedCharacters = withResolvedLocations(currentResult.characters, snapshots);

    // 2b. Resolve sub-locations to extracted canonical locations
    const locResolvedCharacters = resolveCharacterLocationsToExtracted(
      resolvedCharacters,
      currentResult.locations ?? [],
    );

    // 3. Location groups
    const seen = new Map<string, Character[]>();
    for (const c of locResolvedCharacters) {
      const loc = resolveLoc(c.currentLocation) || 'Unknown';
      if (!seen.has(loc)) seen.set(loc, []);
      seen.get(loc)!.push(c);
    }
    const locationGroups: LocationGroup[] = [];
    const locationDescMap = new Map(
      (currentResult.locations ?? []).map((l) => [l.name.toLowerCase(), l.description]),
    );
    for (const [loc, chars] of seen.entries()) {
      const description = locationDescMap.get(loc.toLowerCase());
      locationGroups.push({ location: loc, characters: chars, description });
    }
    locationGroups.sort((a, b) => {
      if (a.location === 'Unknown') return 1;
      if (b.location === 'Unknown') return -1;
      return b.characters.length - a.characters.length;
    });

    // 4. Aggregated entities (pass same alias map)
    const aggregated = aggregateEntities(sorted, currentResult, locationAliasMap);

    // 5. Arc chapter map
    const arcChapterMap = new Map<string, number[]>();
    for (const arc of currentResult.arcs ?? []) {
      const indices: number[] = [];
      for (const snap of sorted) {
        const snapChars = new Set(snap.result.characters.map((c) => c.name.toLowerCase()));
        const hasOverlap = arc.characters.some((c) => snapChars.has(c.toLowerCase()));
        const inSnapArcs = (snap.result.arcs ?? []).some(
          (a) => a.name.toLowerCase() === arc.name.toLowerCase(),
        );
        if (hasOverlap || inSnapArcs) indices.push(snap.index);
      }
      arcChapterMap.set(arc.name, indices);
    }

    return { aggregated, locationAliasMap, resolvedCharacters: locResolvedCharacters, locationGroups, arcChapterMap };
  }, [snapshots, currentResult]);
}
