import type { Character, LocationInfo } from '@/types';
import type { CallAndParseFn } from '@/lib/reconcile';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LocationGroup {
  parentIndex: number;
  absorb: number[];
  children: number[];
  reason: string;
}

export interface GroupLocationResult {
  groups: LocationGroup[];
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export const LOC_GROUP_SYSTEM = `You are a location hierarchy analyst for a literary reading companion.
You review a list of extracted locations and identify sub-locations that
belong to a larger parent location. Your output must be valid JSON and nothing else.

RULES:
- Base your analysis ONLY on the location data provided. Do NOT use external knowledge.
- A sub-location is a room, section, deck, district, or area that is clearly
  part of a larger named place in the list.
- "absorb" = trivial sub-location (room, corridor, cockpit) — merge into parent,
  its description/events fold into the parent.
- "child" = meaningfully distinct sub-location (docks, market district) — keep
  as separate entry but set its parentLocation to the parent.
- Only group when confident. When in doubt, leave the location ungrouped.
- Do NOT create parent locations that aren't already in the list.`;

export const LOC_GROUP_SCHEMA = `{
  "groups": [
    {
      "parentIndex": 0,
      "absorb": [3, 5],
      "children": [7],
      "reason": "Brief explanation"
    }
  ]
}`;

// ─── Prompt builder ─────────────────────────────────────────────────────────

export function buildLocationGroupPrompt(
  bookTitle: string,
  bookAuthor: string,
  locations: LocationInfo[],
  characters: Character[],
): string {
  const locBlock = locations.map((l, i) => {
    const aliases = l.aliases?.length ? l.aliases.join(', ') : 'none';
    const parent = l.parentLocation ?? 'none';
    return `#${i}: ${l.name}
  Aliases: ${aliases}
  Parent: ${parent}
  Description: ${l.description ?? 'No description'}
  Recent events: ${l.recentEvents || 'None'}`;
  }).join('\n\n');

  // Character-at-location cross-reference
  const locMap = new Map<string, string[]>();
  for (const c of characters) {
    const loc = c.currentLocation ?? 'Unknown';
    if (!locMap.has(loc)) locMap.set(loc, []);
    locMap.get(loc)!.push(c.name);
  }
  const crossRef = [...locMap.entries()]
    .map(([loc, names]) => `  ${loc}: ${names.join(', ')}`)
    .join('\n');

  return `BOOK: "${bookTitle}" by ${bookAuthor}

LOCATION LIST (${locations.length} locations):
${locBlock}

CHARACTERS AT EACH LOCATION:
${crossRef}

Review these locations and identify sub-locations that belong to a larger parent location already in the list.
- "absorb": trivial sub-locations (rooms, corridors, cockpits) that should be merged into the parent.
- "children": meaningfully distinct sub-locations (docks, markets, districts) that should keep their own entry but have parentLocation set.

If no grouping is needed, return {"groups": []}.

Return ONLY a JSON object (no markdown fences, no explanation):
${LOC_GROUP_SCHEMA}`;
}

// ─── Application logic ─────────────────────────────────────────────────────

export function applyLocationGroups(
  locations: LocationInfo[],
  characters: Character[],
  groups: LocationGroup[],
): { locations: LocationInfo[]; characters: Character[] } {
  if (!groups.length) return { locations, characters };

  const updatedLocations = locations.map((l) => ({ ...l }));
  let updatedCharacters = characters.map((c) => ({ ...c }));
  const absorbed = new Set<number>();
  const claimed = new Set<number>(); // indices already assigned to a group

  for (const group of groups) {
    // Validate parentIndex
    if (group.parentIndex < 0 || group.parentIndex >= updatedLocations.length) continue;
    if (claimed.has(group.parentIndex)) continue;
    claimed.add(group.parentIndex);

    const parent = updatedLocations[group.parentIndex];

    // Process absorptions
    for (const idx of (group.absorb ?? [])) {
      if (idx < 0 || idx >= updatedLocations.length) continue;
      if (claimed.has(idx)) continue;
      claimed.add(idx);

      const sub = updatedLocations[idx];

      // Append recentEvents
      if (sub.recentEvents) {
        parent.recentEvents = parent.recentEvents
          ? `${parent.recentEvents}; ${sub.recentEvents}`
          : sub.recentEvents;
      }

      // Append description if it adds new info
      if (sub.description && parent.description && !parent.description.toLowerCase().includes(sub.description.toLowerCase().slice(0, 30))) {
        parent.description = `${parent.description} ${sub.description}`;
      }

      // Add sub-location name + aliases to parent aliases
      const parentAliases = new Set((parent.aliases ?? []).map((a) => a.toLowerCase()));
      if (!parentAliases.has(sub.name.toLowerCase()) && sub.name.toLowerCase() !== parent.name.toLowerCase()) {
        parent.aliases = [...(parent.aliases ?? []), sub.name];
      }
      for (const alias of (sub.aliases ?? [])) {
        if (!parentAliases.has(alias.toLowerCase()) && alias.toLowerCase() !== parent.name.toLowerCase()) {
          parent.aliases = [...(parent.aliases ?? []), alias];
          parentAliases.add(alias.toLowerCase());
        }
      }

      // Remap characters at this sub-location
      const subNameLower = sub.name.toLowerCase();
      updatedCharacters = updatedCharacters.map((c) => {
        if (c.currentLocation?.toLowerCase() === subNameLower) {
          return {
            ...c,
            currentLocation: parent.name,
            recentEvents: c.recentEvents
              ? `${c.recentEvents}; previously in ${sub.name}`
              : `previously in ${sub.name}`,
          };
        }
        return c;
      });

      absorbed.add(idx);
    }

    // Process children
    for (const idx of (group.children ?? [])) {
      if (idx < 0 || idx >= updatedLocations.length) continue;
      if (claimed.has(idx)) continue;
      claimed.add(idx);

      updatedLocations[idx].parentLocation = parent.name;
    }
  }

  // Remove absorbed locations
  const finalLocations = updatedLocations.filter((_, i) => !absorbed.has(i));

  return { locations: finalLocations, characters: updatedCharacters };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function groupLocations(
  locations: LocationInfo[],
  characters: Character[],
  bookTitle: string,
  bookAuthor: string,
  callAndParse: CallAndParseFn,
): Promise<{ locations: LocationInfo[]; characters: Character[] }> {
  if (!locations?.length || locations.length < 2) {
    return { locations, characters };
  }

  console.log(`[analyze] Location grouping: evaluating ${locations.length} locations`);

  let result: GroupLocationResult | null = null;
  try {
    result = await callAndParse<GroupLocationResult>(
      LOC_GROUP_SYSTEM,
      buildLocationGroupPrompt(bookTitle, bookAuthor, locations, characters),
      'loc-group',
    );
  } catch (err) {
    console.log(`[analyze] Location grouping failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { locations, characters };
  }

  if (!result?.groups?.length) {
    console.log('[analyze] Location grouping: no groups identified');
    return { locations, characters };
  }

  const { locations: grouped, characters: remapped } = applyLocationGroups(locations, characters, result.groups);

  const absorbedCount = locations.length - grouped.length;
  const childCount = result.groups.reduce((sum, g) => sum + (g.children?.length ?? 0), 0);
  console.log(`[analyze] Location grouping: ${locations.length} → ${grouped.length} locations (${absorbedCount} absorbed, ${childCount} children assigned)`);

  return { locations: grouped, characters: remapped };
}
