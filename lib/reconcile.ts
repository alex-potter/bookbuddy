import type { AnalysisResult, Character, LocationInfo, NarrativeArc } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MergeGroup {
  primary: number;
  absorb: number[];
  reason: string;
  combinedAliases: string[];
}

export interface CharSplitEntry {
  name: string;
  aliases: string[];
  description: string;
}

export interface LocSplitEntry {
  name: string;
  aliases: string[];
  description: string;
}

export interface ArcSplitEntry {
  name: string;
  summary: string;
}

export interface SplitInstruction<T> {
  sourceIndex: number;
  reason: string;
  newEntries: T[];
}

export interface ReconcileResult<T> {
  mergeGroups: MergeGroup[];
  splits: SplitInstruction<T>[];
}

// ─── Proposal types (name-based, for client review) ─────────────────────────

export interface MergeProposal {
  id: string;
  primaryName: string;
  absorbedNames: string[];
  reason: string;
  combinedAliases: string[];
}

export interface SplitProposal {
  id: string;
  sourceName: string;
  reason: string;
  newNames: [string, string];
  newEntries: Array<{ name: string; aliases?: string[]; description?: string; summary?: string }>;
}

export interface ReconcileProposals {
  entityType: 'characters' | 'locations' | 'arcs';
  merges: MergeProposal[];
  splits: SplitProposal[];
}

// ─── Name overlap detection ─────────────────────────────────────────────────

interface NameOverlap { indexA: number; indexB: number; reason: string }

export function computeNameOverlaps(
  entities: Array<{ name: string; aliases?: string[] }>,
  maxPairs = 20,
): NameOverlap[] {
  const results: { overlap: NameOverlap; strength: number }[] = [];

  const namesSets = entities.map((e) => {
    const set = new Set<string>();
    set.add(e.name.toLowerCase());
    for (const a of e.aliases ?? []) set.add(a.toLowerCase());
    return set;
  });

  for (let a = 0; a < entities.length; a++) {
    for (let b = a + 1; b < entities.length; b++) {
      const namesA = [...namesSets[a]];
      const namesB = [...namesSets[b]];

      // Exact match: any name/alias of A matches any name/alias of B
      for (const na of namesA) {
        if (namesSets[b].has(na)) {
          results.push({
            overlap: { indexA: a, indexB: b, reason: `exact name match "${na}"` },
            strength: 3,
          });
          break;
        }
      }
      if (results.length && results[results.length - 1].overlap.indexA === a && results[results.length - 1].overlap.indexB === b && results[results.length - 1].strength === 3) continue;

      // Word-boundary substring: shorter string (>=4 chars) appears at a word boundary in longer string
      let foundSubstring = false;
      for (const na of namesA) {
        if (foundSubstring) break;
        for (const nb of namesB) {
          if (foundSubstring) break;
          const shorter = na.length <= nb.length ? na : nb;
          const longer = na.length <= nb.length ? nb : na;
          if (shorter.length < 4 || shorter === longer) continue;
          const re = new RegExp(`\\b${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (re.test(longer)) {
            const origShorter = na.length <= nb.length ? na : nb;
            const origLonger = na.length <= nb.length ? nb : na;
            results.push({
              overlap: { indexA: a, indexB: b, reason: `name "${origShorter}" is contained in "${origLonger}"` },
              strength: 2,
            });
            foundSubstring = true;
          }
        }
      }
      if (foundSubstring) continue;

      // Shared token: a single word token >=5 chars appears in both name sets
      const tokensA = new Set(namesA.flatMap((n) => n.split(/\s+/).filter((t) => t.length >= 5)));
      for (const nb of namesB) {
        let found = false;
        for (const token of nb.split(/\s+/)) {
          if (token.length >= 5 && tokensA.has(token)) {
            results.push({
              overlap: { indexA: a, indexB: b, reason: `shared token "${token}"` },
              strength: 1,
            });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
  }

  // Sort by strength descending, cap at maxPairs
  results.sort((a, b) => b.strength - a.strength);
  return results.slice(0, maxPairs).map((r) => r.overlap);
}

// ─── Prompts ────────────────────────────────────────────────────────────────

export const CHAR_RECONCILE_SYSTEM = `You are a literary data quality analyst. You review character lists extracted from books and identify duplicates (same person listed under different names) and incorrect merges (distinct people incorrectly combined into one entry).

CRITICAL RULES:
- Base your analysis ONLY on the character data provided — names, aliases, descriptions, relationships, locations, lastSeen, and recentEvents. Do NOT use any external knowledge of the book or series.
- Characters where one name is a prefix or substring of the other are strong merge candidates. Patronymics ("Son of X"), titles ("King", "Lord"), and epithets ("the White") are NOT surnames — they do not indicate different characters.
- Do NOT merge characters who have genuinely different family names (e.g. "Jon Snow" and "Jon Arryn" are DIFFERENT people).
- Do NOT merge characters who are at different locations or have conflicting relationships.
- Focus on the POTENTIAL DUPLICATES section if provided — pairs listed there deserve careful examination. Characters NOT listed there are unlikely to be duplicates.
- Only merge when you are CERTAIN they are the same person — when in doubt, keep them separate.
- Prefer keeping characters separate over merging. False merges destroy information; false splits are easily fixed later.

Your output must be valid JSON and nothing else.`;

export const CHAR_RECONCILE_SCHEMA = `{
  "mergeGroups": [
    {
      "primary": 0,
      "absorb": [3],
      "reason": "Brief explanation of why these are the same person",
      "combinedAliases": ["all names and aliases for this person"]
    }
  ],
  "splits": [
    {
      "sourceIndex": 5,
      "reason": "Brief explanation of why this entry is actually two people",
      "newEntries": [
        { "name": "Person A full name", "aliases": ["..."], "description": "..." },
        { "name": "Person B full name", "aliases": ["..."], "description": "..." }
      ]
    }
  ]
}`;

export const LOC_RECONCILE_SYSTEM = `You are a literary data quality analyst. You review location lists extracted from books and identify duplicates (same place listed under different names) and incorrect merges (distinct places incorrectly combined into one entry).

CRITICAL RULES:
- Base your analysis ONLY on the location data provided — names, aliases, descriptions, relationships, arcs, parentLocations, and recentEvents. Do NOT use any external knowledge of the book.
- Geographic qualifiers ("the city of X", "X Province") and formal variants ("Kingdom of Rohan" vs "Rohan") are strong merge candidates — these often refer to the same place.
- Do NOT merge locations that have different parent locations or clearly distinct descriptions.
- Focus on the POTENTIAL DUPLICATES section if provided — pairs listed there deserve careful examination. Locations NOT listed there are unlikely to be duplicates.
- Only merge when you are CERTAIN they are the same place — when in doubt, keep them separate.
- Prefer keeping locations separate over merging. False merges destroy information; false splits are easily fixed later.

Your output must be valid JSON and nothing else.`;

export const LOC_RECONCILE_SCHEMA = `{
  "mergeGroups": [
    {
      "primary": 0,
      "absorb": [2],
      "reason": "Brief explanation of why these are the same place",
      "combinedAliases": ["all names and aliases for this place"]
    }
  ],
  "splits": [
    {
      "sourceIndex": 4,
      "reason": "Brief explanation of why this entry is actually two places",
      "newEntries": [
        { "name": "Place A name", "aliases": ["..."], "description": "..." },
        { "name": "Place B name", "aliases": ["..."], "description": "..." }
      ]
    }
  ]
}`;

// ─── Prompt builders ────────────────────────────────────────────────────────

export function buildCharReconcilePrompt(
  bookTitle: string, bookAuthor: string, characters: Character[], chapterExcerpts?: string,
): string {
  const charBlock = characters.map((c, i) => {
    const rels = c.relationships?.length
      ? c.relationships.map((r) => `${r.character} (${r.relationship})`).join(', ')
      : 'none';
    return `#${i}: ${c.name}
  Aliases: ${c.aliases?.length ? c.aliases.join(', ') : 'none'}
  Importance: ${c.importance}, Status: ${c.status}
  Location: ${c.currentLocation ?? 'Unknown'}
  Last seen: ${c.lastSeen || 'Unknown'}
  Description: ${c.description ?? 'No description'}
  Recent events: ${c.recentEvents || 'None'}
  Relationships: ${rels}`;
  }).join('\n\n');

  const textSection = chapterExcerpts
    ? `\nRECENT CHAPTER TEXT (use to verify whether character names actually appear in the book):\n${chapterExcerpts.slice(0, 15_000)}\n`
    : '';

  const overlaps = computeNameOverlaps(characters);
  const overlapSection = overlaps.length > 0
    ? `\nPOTENTIAL DUPLICATES TO EXAMINE (verify using descriptions, relationships, and locations before merging):\n${overlaps.map((o) => `- #${o.indexA} "${characters[o.indexA].name}" and #${o.indexB} "${characters[o.indexB].name}": ${o.reason}`).join('\n')}\n\nCharacters NOT listed above are unlikely to be duplicates — do not merge them unless you find strong evidence.\n`
    : '';

  return `BOOK: "${bookTitle}" by ${bookAuthor}
${textSection}
CHARACTER LIST (${characters.length} characters):
${charBlock}
${overlapSection}
Review these characters and identify:
1. MERGE groups: characters that are CLEARLY the same person listed twice (e.g., a full name "Matrim Cauthon" and a standalone nickname "Mat" that weren't linked). Only merge when the evidence is strong — shared relationships, matching descriptions, complementary aliases. Do NOT merge characters who merely share a first name, title, or common word.
2. SPLIT entries: characters that appear to be two or more distinct people incorrectly merged into one entry (e.g., conflicting locations, descriptions, or relationships suggesting two different people). For each split, describe what the separate entries should look like.
3. HALLUCINATIONS: if chapter text is provided, flag any characters whose name does NOT appear anywhere in the text — place them in a merge group with absorb only (no primary) or mark them for dropping.

When in doubt, do NOT merge — it is better to have a duplicate entry than to destroy a distinct character. If no merges or splits are needed, return {"mergeGroups": [], "splits": []}.

Return ONLY a JSON object (no markdown fences, no explanation):
${CHAR_RECONCILE_SCHEMA}`;
}

export function buildLocReconcilePrompt(
  bookTitle: string, bookAuthor: string, locations: LocationInfo[], characters: Character[], chapterExcerpts?: string,
): string {
  const locBlock = locations.map((l, i) => {
    const rels = l.relationships?.length
      ? l.relationships.map((r) => `${r.location} (${r.relationship})`).join(', ')
      : 'none';
    return `#${i}: ${l.name}
  Aliases: ${l.aliases?.length ? l.aliases.join(', ') : 'none'}
  Arc: ${l.arc ?? 'Unknown'}
  Parent location: ${l.parentLocation ?? 'None'}
  Description: ${l.description ?? 'No description'}
  Recent events: ${l.recentEvents || 'None'}
  Relationships: ${rels}`;
  }).join('\n\n');

  const locMap = new Map<string, string[]>();
  for (const c of characters) {
    const loc = c.currentLocation ?? 'Unknown';
    if (!locMap.has(loc)) locMap.set(loc, []);
    locMap.get(loc)!.push(c.name);
  }
  const crossRef = [...locMap.entries()]
    .map(([loc, names]) => `  ${loc}: ${names.join(', ')}`)
    .join('\n');

  const textSection = chapterExcerpts
    ? `\nRECENT CHAPTER TEXT (use to verify whether location names actually appear in the book):\n${chapterExcerpts.slice(0, 15_000)}\n`
    : '';

  const overlaps = computeNameOverlaps(locations);
  const overlapSection = overlaps.length > 0
    ? `\nPOTENTIAL DUPLICATES TO EXAMINE (verify using descriptions, relationships, and parent locations before merging):\n${overlaps.map((o) => `- #${o.indexA} "${locations[o.indexA].name}" and #${o.indexB} "${locations[o.indexB].name}": ${o.reason}`).join('\n')}\n\nLocations NOT listed above are unlikely to be duplicates — do not merge them unless you find strong evidence.\n`
    : '';

  return `BOOK: "${bookTitle}" by ${bookAuthor}
${textSection}
LOCATION LIST (${locations.length} locations):
${locBlock}
${overlapSection}
CHARACTERS AT EACH LOCATION (for cross-reference):
${crossRef}

Review these locations and identify:
1. MERGE groups: locations that are actually the same place (e.g., different names for the same city, or a sub-location that should be absorbed into its parent).
2. SPLIT entries: locations that appear to be distinct places incorrectly merged into one entry.

If no merges or splits are needed, return {"mergeGroups": [], "splits": []}.

Return ONLY a JSON object (no markdown fences, no explanation):
${LOC_RECONCILE_SCHEMA}`;
}

// ─── Arc reconciliation prompts ─────────────────────────────────────────────

export const ARC_RECONCILE_SYSTEM = `You are a literary data quality analyst. You review narrative arc lists extracted from books and identify duplicates (same plot thread listed under different names) and incorrect merges (distinct plot threads incorrectly combined into one entry).

Base your analysis ONLY on the arc data provided — names, statuses, characters, and summaries. Do NOT use any external knowledge of the book.

Your output must be valid JSON and nothing else.`;

export const ARC_RECONCILE_SCHEMA = `{
  "mergeGroups": [
    {
      "primary": 0,
      "absorb": [2],
      "reason": "Brief explanation of why these are the same plot thread",
      "combinedAliases": []
    }
  ],
  "splits": [
    {
      "sourceIndex": 3,
      "reason": "Brief explanation of why this entry is actually two plot threads",
      "newEntries": [
        { "name": "Arc A name", "summary": "..." },
        { "name": "Arc B name", "summary": "..." }
      ]
    }
  ]
}`;

export function buildArcReconcilePrompt(
  bookTitle: string, bookAuthor: string, arcs: NarrativeArc[], characters: Character[],
): string {
  const arcBlock = arcs.map((a, i) => {
    return `#${i}: ${a.name}
  Status: ${a.status}
  Characters: ${a.characters.length ? a.characters.join(', ') : 'none'}
  Summary: ${a.summary ?? 'No summary'}`;
  }).join('\n\n');

  const charSummary = characters.map((c) =>
    `- ${c.name} (${c.importance}, ${c.status})`
  ).join('\n');

  return `BOOK: "${bookTitle}" by ${bookAuthor}

ARC LIST (${arcs.length} arcs):
${arcBlock}

CHARACTERS (for cross-reference):
${charSummary}

Review these narrative arcs and identify:
1. MERGE groups: arcs that are clearly the same plot thread listed under different names (e.g., two arcs covering the same conflict or journey with overlapping characters).
2. SPLIT entries: arcs that appear to describe two or more distinct plot threads incorrectly combined into one entry (e.g., unrelated conflicts merged together).

When in doubt, do NOT merge — it is better to have a duplicate arc than to destroy a distinct plot thread. If no merges or splits are needed, return {"mergeGroups": [], "splits": []}.

Return ONLY a JSON object (no markdown fences, no explanation):
${ARC_RECONCILE_SCHEMA}`;
}

// ─── Index-to-name proposal translator ──────────────────────────────────────

export function indexProposalsToNamed(
  entityType: 'characters' | 'locations' | 'arcs',
  entities: Array<{ name: string; aliases?: string[] }>,
  raw: ReconcileResult<CharSplitEntry | LocSplitEntry | ArcSplitEntry>,
): ReconcileProposals {
  const merges: MergeProposal[] = [];
  const splits: SplitProposal[] = [];

  for (const group of raw.mergeGroups ?? []) {
    if (group.primary < 0 || group.primary >= entities.length) continue;
    const validAbsorb = (group.absorb ?? []).filter((i) => i >= 0 && i < entities.length && i !== group.primary);
    if (validAbsorb.length === 0) continue;
    merges.push({
      id: crypto.randomUUID(),
      primaryName: entities[group.primary].name,
      absorbedNames: validAbsorb.map((i) => entities[i].name),
      reason: group.reason ?? '',
      combinedAliases: group.combinedAliases ?? [],
    });
  }

  for (const split of raw.splits ?? []) {
    if (split.sourceIndex < 0 || split.sourceIndex >= entities.length) continue;
    if (!split.newEntries || split.newEntries.length < 2) continue;
    splits.push({
      id: crypto.randomUUID(),
      sourceName: entities[split.sourceIndex].name,
      reason: split.reason ?? '',
      newNames: [split.newEntries[0].name, split.newEntries[1].name],
      newEntries: split.newEntries.map((e) => ({
        name: e.name,
        ...('aliases' in e ? { aliases: (e as CharSplitEntry | LocSplitEntry).aliases } : {}),
        ...('description' in e ? { description: (e as CharSplitEntry | LocSplitEntry).description } : {}),
        ...('summary' in e ? { summary: (e as ArcSplitEntry).summary } : {}),
      })),
    });
  }

  return { entityType, merges, splits };
}

// ─── Apply logic ────────────────────────────────────────────────────────────

export function applyCharacterReconciliation(
  characters: Character[],
  response: ReconcileResult<CharSplitEntry>,
): { characters: Character[]; nameMap: Map<string, string> } {
  const result = characters.map((c) => ({ ...c }));
  const nameMap = new Map<string, string>();

  const validSplits = (response.splits ?? [])
    .filter((s) => s.sourceIndex >= 0 && s.sourceIndex < result.length && s.newEntries?.length >= 2);
  validSplits.sort((a, b) => b.sourceIndex - a.sourceIndex);

  for (const split of validSplits) {
    const source = result[split.sourceIndex];
    console.log(`[reconcile] Splitting character #${split.sourceIndex} "${source.name}": ${split.reason}`);
    const newChars: Character[] = split.newEntries.map((entry) => ({
      ...source,
      name: entry.name,
      aliases: entry.aliases ?? [],
      description: entry.description ?? source.description,
    }));
    result.splice(split.sourceIndex, 1, ...newChars);
  }

  const toRemove = new Set<number>();
  for (const group of response.mergeGroups ?? []) {
    if (group.primary < 0 || group.primary >= result.length) continue;
    const validAbsorb = (group.absorb ?? []).filter((i) => i >= 0 && i < result.length && i !== group.primary);
    if (validAbsorb.length === 0) continue;

    const primary = result[group.primary];
    console.log(`[reconcile] Merging characters: "${primary.name}" absorbs ${validAbsorb.map((i) => `"${result[i].name}"`).join(', ')}: ${group.reason}`);

    for (const idx of validAbsorb) {
      const absorbed = result[idx];
      const absorbedNames = [absorbed.name, ...(absorbed.aliases ?? [])];
      for (const n of absorbedNames) nameMap.set(n.toLowerCase(), primary.name);

      if (absorbed.description && absorbed.description.length > (primary.description?.length ?? 0)) {
        primary.description = absorbed.description;
      }
      const importanceOrder: Record<string, number> = { main: 3, secondary: 2, minor: 1 };
      if ((importanceOrder[absorbed.importance] ?? 0) > (importanceOrder[primary.importance] ?? 0)) {
        primary.importance = absorbed.importance;
      }
      const existingRels = new Set(primary.relationships?.map((r) => r.character.toLowerCase()) ?? []);
      for (const rel of absorbed.relationships ?? []) {
        if (!existingRels.has(rel.character.toLowerCase())) {
          primary.relationships = [...(primary.relationships ?? []), rel];
          existingRels.add(rel.character.toLowerCase());
        }
      }
      toRemove.add(idx);
    }

    const allAliases = new Set([
      ...(primary.aliases ?? []),
      ...(group.combinedAliases ?? []),
    ].map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== primary.name.toLowerCase()));
    primary.aliases = [...allAliases];
  }

  const removeList = [...toRemove].sort((a, b) => b - a);
  for (const idx of removeList) result.splice(idx, 1);

  for (const char of result) {
    if (char.relationships) {
      char.relationships = char.relationships.map((r) => ({
        ...r,
        character: nameMap.get(r.character.toLowerCase()) ?? r.character,
      }));
    }
  }

  return { characters: result, nameMap };
}

export function applyLocationReconciliation(
  locations: LocationInfo[],
  characters: Character[],
  response: ReconcileResult<LocSplitEntry>,
): { locations: LocationInfo[]; characters: Character[] } {
  const result = locations.map((l) => ({ ...l }));
  const locNameMap = new Map<string, string>();

  const validSplits = (response.splits ?? [])
    .filter((s) => s.sourceIndex >= 0 && s.sourceIndex < result.length && s.newEntries?.length >= 2);
  validSplits.sort((a, b) => b.sourceIndex - a.sourceIndex);

  for (const split of validSplits) {
    const source = result[split.sourceIndex];
    console.log(`[reconcile] Splitting location #${split.sourceIndex} "${source.name}": ${split.reason}`);
    const newLocs: LocationInfo[] = split.newEntries.map((entry) => ({
      ...source,
      name: entry.name,
      aliases: entry.aliases?.length ? entry.aliases : undefined,
      description: entry.description ?? source.description,
    }));
    result.splice(split.sourceIndex, 1, ...newLocs);
  }

  const toRemove = new Set<number>();
  for (const group of response.mergeGroups ?? []) {
    if (group.primary < 0 || group.primary >= result.length) continue;
    const validAbsorb = (group.absorb ?? []).filter((i) => i >= 0 && i < result.length && i !== group.primary);
    if (validAbsorb.length === 0) continue;

    const primary = result[group.primary];
    console.log(`[reconcile] Merging locations: "${primary.name}" absorbs ${validAbsorb.map((i) => `"${result[i].name}"`).join(', ')}: ${group.reason}`);

    for (const idx of validAbsorb) {
      const absorbed = result[idx];
      const absorbedNames = [absorbed.name, ...(absorbed.aliases ?? [])];
      for (const n of absorbedNames) locNameMap.set(n.toLowerCase(), primary.name);

      if (absorbed.description && absorbed.description.length > (primary.description?.length ?? 0)) {
        primary.description = absorbed.description;
      }
      const existingRels = new Set(primary.relationships?.map((r) => r.location.toLowerCase()) ?? []);
      for (const rel of absorbed.relationships ?? []) {
        if (!existingRels.has(rel.location.toLowerCase())) {
          primary.relationships = [...(primary.relationships ?? []), rel];
          existingRels.add(rel.location.toLowerCase());
        }
      }
      if (!primary.arc && absorbed.arc) primary.arc = absorbed.arc;

      toRemove.add(idx);
    }

    const allAliases = new Set([
      ...(primary.aliases ?? []),
      ...(group.combinedAliases ?? []),
    ].map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== primary.name.toLowerCase()));
    primary.aliases = allAliases.size > 0 ? [...allAliases] : undefined;
  }

  const removeList = [...toRemove].sort((a, b) => b - a);
  for (const idx of removeList) result.splice(idx, 1);

  for (const loc of result) {
    if (loc.relationships) {
      loc.relationships = loc.relationships.map((r) => ({
        ...r,
        location: locNameMap.get(r.location.toLowerCase()) ?? r.location,
      }));
    }
  }

  const updatedChars = characters.map((c) => {
    const mapped = c.currentLocation ? locNameMap.get(c.currentLocation.toLowerCase()) : undefined;
    return mapped ? { ...c, currentLocation: mapped } : c;
  });

  return { locations: result, characters: updatedChars };
}

export function updateArcReferences(
  arcs: AnalysisResult['arcs'],
  nameMap: Map<string, string>,
): AnalysisResult['arcs'] {
  if (!arcs?.length || nameMap.size === 0) return arcs;
  return arcs.map((arc) => ({
    ...arc,
    characters: [...new Set(arc.characters.map((c) => nameMap.get(c.toLowerCase()) ?? c))],
  }));
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export type CallAndParseFn = <T>(system: string, userPrompt: string, label: string) => Promise<T | null>;

export async function reconcileResult(
  result: AnalysisResult,
  bookTitle: string,
  bookAuthor: string,
  chapterExcerpts: string | undefined,
  callAndParse: CallAndParseFn,
): Promise<AnalysisResult> {
  let characters = result.characters;
  let locations = result.locations;
  let arcs = result.arcs;

  // Pass 1: Character reconciliation
  console.log(`[reconcile] Pass 1: characters (${characters.length} entries)`);
  const charResponse = await callAndParse<ReconcileResult<CharSplitEntry>>(
    CHAR_RECONCILE_SYSTEM,
    buildCharReconcilePrompt(bookTitle, bookAuthor, characters, chapterExcerpts),
    'char-reconcile',
  );

  let nameMap = new Map<string, string>();
  if (charResponse && (charResponse.mergeGroups?.length || charResponse.splits?.length)) {
    const charResult = applyCharacterReconciliation(characters, charResponse);
    characters = charResult.characters;
    nameMap = charResult.nameMap;
    arcs = updateArcReferences(arcs, nameMap);
    console.log(`[reconcile] Pass 1 done: ${characters.length} characters after reconciliation`);
  } else {
    console.log('[reconcile] Pass 1 done: no character changes needed');
  }

  // Pass 2: Location reconciliation
  if (locations?.length) {
    console.log(`[reconcile] Pass 2: locations (${locations.length} entries)`);
    const locResponse = await callAndParse<ReconcileResult<LocSplitEntry>>(
      LOC_RECONCILE_SYSTEM,
      buildLocReconcilePrompt(bookTitle, bookAuthor, locations, characters, chapterExcerpts),
      'loc-reconcile',
    );

    if (locResponse && (locResponse.mergeGroups?.length || locResponse.splits?.length)) {
      const locResult = applyLocationReconciliation(locations, characters, locResponse);
      locations = locResult.locations;
      characters = locResult.characters;
      console.log(`[reconcile] Pass 2 done: ${locations.length} locations after reconciliation`);
    } else {
      console.log('[reconcile] Pass 2 done: no location changes needed');
    }
  }

  return {
    characters,
    locations: locations?.length ? locations : undefined,
    arcs: arcs?.length ? arcs : undefined,
    summary: result.summary,
  };
}
