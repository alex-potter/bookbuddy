import { NextRequest, NextResponse } from 'next/server';
import type { AnalysisResult } from '@/types';
import { reconcileResult, computeNameOverlaps, updateArcReferences, buildCharReconcilePrompt, type CallAndParseFn } from '@/lib/reconcile';
import { levenshtein } from '@/lib/ai-shared';
import { escapeRegex, validateCharactersAgainstText, validateLocationsAgainstText } from '@/lib/validate-entities';
import { callLLM, resolveConfig, type LLMResult } from '@/lib/llm';
import { getContextWindow, splitChapterText, computeTextBudget } from '@/lib/context-window';
import type { ProviderType } from '@/lib/rate-limiter';

// ─── System prompts (one per pass) ───────────────────────────────────────────

const ANTI_SPOILER = `Your most important rule is NEVER SPOILING anything beyond what appears in the text provided.

STRICT ANTI-SPOILER RULES (follow these without exception):
1. Base ALL information SOLELY on the text excerpt provided — nothing else.
2. If you recognise this book or series, IGNORE that knowledge entirely. Pretend you have never seen it before.
3. Only report facts that are explicitly stated or clearly implied by the text given.
4. If a character's fate, location, or status is uncertain based on the text, say so — do NOT infer from broader knowledge.
5. Do NOT hint at, foreshadow, or allude to future events in any way.

Your output must be valid JSON and nothing else.`;

const ARCS_SYSTEM = `You are a narrative arc analyst for a literary reading companion. ${ANTI_SPOILER}`;

const CHARACTERS_SYSTEM = `You are a character tracker for a literary reading companion. ${ANTI_SPOILER}

CHARACTER EXTRACTION RULES:
- Include every named character who LITERALLY APPEARS BY NAME in the text provided — protagonists, antagonists, and minor characters alike.
- A character mentioned once by name still gets an entry.
- Never filter, skip, or summarize away characters because they seem unimportant.
- NEVER group characters together (e.g. do NOT create entries like "The Hobbits", "The Fellowship", "The Guards"). Every individual must have their own separate entry under their own name.

ANTI-HALLUCINATION RULES (critical):
- ONLY include characters whose name or alias literally appears as text in the provided chapter.
- Do NOT invent or infer characters from context clues, summaries, or your knowledge of the book/series.
- If you are unsure whether a name refers to a character, include it — but NEVER fabricate a name that does not appear in the text.

DEDUPLICATION RULES (critical):
- A character must appear EXACTLY ONCE regardless of how many names or nicknames they are called by.
- If the same person is referred to by multiple names (e.g. "Matrim Cauthon" and "Mat"), create ONE entry using their fullest known name and list all shorter forms in "aliases".
- Never create separate entries for a full name and its nickname or shortened form.
- Titles and epithets for the same person (e.g. "the Dragon Reborn" for "Rand al'Thor") must be listed as aliases, not separate entries.`;

const LOCATIONS_SYSTEM = `You are a location and world-building tracker for a literary reading companion. ${ANTI_SPOILER}`;

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ARC_SCHEMA = `{
  "arcs": [
    {
      "name": "Short name for this plot thread (e.g. 'Frodo\\'s journey to Mordor')",
      "status": "active" | "resolved" | "dormant",
      "characters": ["character names involved in this arc"],
      "summary": "1–2 sentences on where this arc stands right now"
    }
  ]
}`;

const ARC_DELTA_SCHEMA = `{
  "updatedArcs": [
    {
      "name": "Arc name — must exactly match an existing arc name (or renamedArcs new name), or be genuinely new",
      "status": "active" | "resolved" | "dormant",
      "characters": ["character names involved"],
      "summary": "1–2 sentences on where this arc stands after this chapter"
    }
  ],
  "renamedArcs": [
    { "from": "exact existing arc name", "to": "new arc name reflecting its evolved scope or phase" }
  ],
  "retiredArcs": ["exact name of any arc being permanently dropped — NOT ones being renamed"]
}`;

const CHARACTER_SCHEMA = `{
  "characters": [
    {
      "name": "Full character name",
      "aliases": ["any nicknames, shortened names, or titles used in the text — leave empty array [] if none"],
      "importance": "main" | "secondary" | "minor",
      "status": "alive" | "dead" | "unknown" | "uncertain",
      "lastSeen": "Chapter title where they last appeared",
      "currentLocation": "A named place only — city, castle, planet, region, ship name. NEVER a status or activity (not 'Dead', 'Returning Home', 'Travelling', 'En Route', 'In Battle', 'Unknown Location'). If the character has no confirmed place, use exactly 'Unknown'.",
      "description": "1–2 sentence description of who they are, their role, and appearance/personality as established so far",
      "relationships": [
        { "character": "Other character's name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key things that have happened to or involving this character in the most recent chapters read"
    }
  ]
}`;

const CHARACTER_DELTA_SCHEMA = `{
  "updatedCharacters": [
    {
      "name": "Full character name",
      "aliases": ["any nicknames, shortened names, or titles used in the text — leave empty array [] if none"],
      "importance": "main" | "secondary" | "minor",
      "status": "alive" | "dead" | "unknown" | "uncertain",
      "lastSeen": "Chapter title where they last appeared",
      "currentLocation": "A named place only — city, castle, planet, region, ship name. NEVER a status or activity (not 'Dead', 'Returning Home', 'Travelling', 'En Route', 'In Battle', 'Unknown Location'). If the character has no confirmed place, use exactly 'Unknown'.",
      "description": "1–2 sentence description (carry forward from existing state if unchanged)",
      "relationships": [
        { "character": "Other character's name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key things that happened in the NEW chapter only"
    }
  ]
}`;

const LOCATION_SCHEMA = `{
  "locations": [
    {
      "name": "Broad canonical place name — city, castle, region, planet, ship (NOT a generic room, corridor, or sub-location). Prefer the containing location over sub-locations.",
      "aliases": ["shorter or alternate names readers use for this place — e.g. 'Ceres' for 'Ceres Station', 'the Pits' for 'Hellas Basin'"],
      "description": "1–2 sentence description of this place — what kind of place it is, its significance, atmosphere, or notable features as established in the text",
      "recentEvents": "1–2 sentences describing what happened at this location in the current chapter. Omit if nothing notable occurred here.",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate — e.g. 'contains', 'part of', 'adjacent to', 'connected by road to', 'visible from', 'governs', 'supplies'" }
      ]
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter, from the reader's perspective"
}`;

const LOCATION_DELTA_SCHEMA = `{
  "updatedLocations": [
    {
      "name": "Broad canonical place name — city, castle, region, planet, ship. Use an EXISTING LOCATION NAME if the place is the same, nearby, or contained within it.",
      "aliases": ["shorter or alternate names readers use for this place — only include if genuinely used in the text"],
      "description": "1–2 sentence description of this place as revealed so far",
      "recentEvents": "1–2 sentences describing what happened at this location in this chapter. Omit if nothing notable occurred here.",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate" }
      ]
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter"
}`;

// ─── Local model prompt variants ──────────────────────────────────────────────

const CHARACTERS_SYSTEM_LOCAL = `You are a character tracker for a literary reading companion. Your output must be valid JSON and nothing else.

RULES:
1. Base ALL information SOLELY on the text provided. Do NOT use any knowledge of the book.
2. If you recognize this book, IGNORE that knowledge. Only report facts explicitly stated in the text.
3. Include every named character who appears by name in the text — protagonists, antagonists, and minor characters.
4. A character mentioned once by name still gets an entry.
5. ONLY include characters whose name literally appears in the provided text. Do NOT invent characters.
6. A character must appear EXACTLY ONCE. If the same person is called multiple names (e.g. "Matrim Cauthon" and "Mat"), create ONE entry using the fullest name and list shorter forms in "aliases".
7. Never create separate entries for a full name and its nickname. Titles/epithets go in aliases.
8. NEVER group characters together (e.g. "The Hobbits", "The Fellowship"). Every individual gets their own entry.`;

const LOCATIONS_SYSTEM_LOCAL = `You are a location tracker for a literary reading companion. Your output must be valid JSON and nothing else.

RULES:
1. Base ALL information SOLELY on the text provided. Do NOT use any knowledge of the book.
2. Extract significant named locations — cities, castles, regions, planets, ships.
3. Prefer broad canonical place names over sub-locations (rooms, corridors, hallways).
4. If a place is inside another listed location, use the containing location instead.
5. Include aliases — common shorter names for the same place.
6. Include a 2–3 sentence story summary of where the narrative stands.`;

const ARCS_SYSTEM_LOCAL = `You are a narrative arc analyst for a literary reading companion. Your output must be valid JSON and nothing else.

RULES:
1. Base ALL information SOLELY on the text provided. Do NOT use any knowledge of the book.
2. Identify 3–7 major plot threads. Fewer is better — combine closely related threads.
3. Each arc should span multiple chapters with ongoing stakes. Do not create per-scene micro-arcs.
4. Status values: "active" = ongoing, "resolved" = concluded, "dormant" = paused.`;

const CHARACTER_SCHEMA_LOCAL = `{
  "characters": [
    {
      "name": "Full character name",
      "aliases": [],
      "importance": "main" | "secondary" | "minor",
      "status": "alive" | "dead" | "unknown" | "uncertain",
      "lastSeen": "Chapter title",
      "currentLocation": "Named place or 'Unknown'",
      "description": "1–2 sentence description",
      "relationships": [
        { "character": "Name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key events this chapter"
    }
  ]
}`;

const CHARACTER_DELTA_SCHEMA_LOCAL = `{
  "updatedCharacters": [
    {
      "name": "Full character name",
      "aliases": [],
      "importance": "main" | "secondary" | "minor",
      "status": "alive" | "dead" | "unknown" | "uncertain",
      "lastSeen": "Chapter title",
      "currentLocation": "Named place or 'Unknown'",
      "description": "1–2 sentence description",
      "relationships": [
        { "character": "Name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key events this chapter"
    }
  ]
}`;

const LOCATION_SCHEMA_LOCAL = `{
  "locations": [
    {
      "name": "Canonical place name",
      "aliases": [],
      "description": "1–2 sentence description",
      "recentEvents": "What happened here this chapter",
      "relationships": [
        { "location": "Place name", "relationship": "How they relate" }
      ]
    }
  ],
  "summary": "2–3 sentence story summary"
}`;

const LOCATION_DELTA_SCHEMA_LOCAL = `{
  "updatedLocations": [
    {
      "name": "Canonical place name (reuse existing name if same place)",
      "aliases": [],
      "description": "1–2 sentence description",
      "recentEvents": "What happened here this chapter",
      "relationships": [
        { "location": "Place name", "relationship": "How they relate" }
      ]
    }
  ],
  "summary": "2–3 sentence story summary"
}`;

// ─── Verification pass ────────────────────────────────────────────────────────

const VERIFICATION_SYSTEM = `You are a data quality reviewer for a literary reading companion. You verify character extraction results against source text to catch hallucinated or duplicate entries. Your output must be valid JSON and nothing else.`;

interface Verdict {
  index: number;
  action: 'keep' | 'drop';
  reason?: string;
}

function buildVerificationPrompt(
  characters: AnalysisResult['characters'],
  chapterText: string,
  maxTextChars?: number,
): string {
  const charBlock = characters.map((c, i) =>
    `#${i}: ${c.name} (aliases: ${c.aliases?.join(', ') || 'none'})`,
  ).join('\n');

  const maxTextLen = maxTextChars ?? 80_000;
  const truncatedText = chapterText.length > maxTextLen
    ? chapterText.slice(0, maxTextLen) + '\n[...truncated...]'
    : chapterText;

  return `EXTRACTED CHARACTERS:
${charBlock}

CHAPTER TEXT:
${truncatedText}

Review each extracted character against the chapter text. For each, determine:
Does this character's name or at least one alias actually appear in the chapter text? Mark as "drop" if not, "keep" if yes.

Return ONLY a JSON object:
{
  "verdicts": [
    { "index": 0, "action": "keep" },
    { "index": 1, "action": "drop", "reason": "Name does not appear in text" }
  ]
}

Rules:
- Only mark "drop" if you are confident the character does not appear in the text at all.
- When in doubt, keep the character.`;
}

function applyVerificationVerdicts(
  chars: AnalysisResult['characters'],
  verdicts: Verdict[],
): AnalysisResult['characters'] {
  const toDrop = new Set<number>();

  for (const v of verdicts) {
    if (v.index < 0 || v.index >= chars.length) continue;
    if (v.action === 'drop') {
      toDrop.add(v.index);
      console.log(`[verify] Drop #${v.index} "${chars[v.index].name}": ${v.reason}`);
    }
  }

  return chars.filter((_, i) => !toDrop.has(i));
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildArcsFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  text: string,
  characters: AnalysisResult['characters'],
  locations: AnalysisResult['locations'],
  allChapterTitles?: string[],
): string {
  const tocBlock = allChapterTitles && allChapterTitles.length > 1
    ? `\nTABLE OF CONTENTS (${allChapterTitles.length} chapters total — use this to calibrate arc scope):\n${allChapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".
${tocBlock}
CHARACTERS (use these names when listing characters involved in each arc):
${charactersSummary(characters)}

LOCATIONS:
${locationsSummary(locations)}

Identify the major narrative plot threads (arcs) present in the text below. Use the character and location lists above to inform your arc identification — group characters and locations into coherent storylines.

TEXT:
${text}

ARC RULES:
- Identify 3–7 major plot threads (fewer is better — combine closely related threads into one).
- Each arc should span multiple chapters and drive meaningful story action.
- Do not create an arc for every scene; only for threads that have clear ongoing stakes.
- "status": "active" = ongoing, "resolved" = concluded, "dormant" = paused/not mentioned recently.
- The table of contents above shows the full scope of the book — create arcs broad enough to last, not micro-arcs for individual scenes.
- You are seeing the complete story so far. Synthesize arcs that span the entire narrative. Merge closely related threads into cohesive arcs rather than creating per-chapter micro-arcs.

Return ONLY a JSON object (no markdown fences, no explanation):
${ARC_SCHEMA}`;
}

function buildArcsDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  previousArcs: AnalysisResult['arcs'],
  characters: AnalysisResult['characters'],
  locations: AnalysisResult['locations'],
  text: string,
): string {
  const arcCount = previousArcs?.length ?? 0;
  const arcLines = (previousArcs ?? [])
    .map((a) => `- ${a.name} [${a.status}]: ${a.summary}`)
    .join('\n');
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

EXISTING NARRATIVE ARCS (${arcCount} total — target is 3–6; use "retiredArcs" to drop any that have been absorbed or concluded):
${arcLines}

CHARACTERS:
${charactersSummary(characters)}

LOCATIONS:
${locationsSummary(locations)}

NEW CHAPTER TEXT:
${text}

Update the arcs based on this new chapter. Use the character and location lists above to inform arc updates. ARC CONTINUITY RULES:
- If an arc cleanly transitions into a new phase with the same characters and storyline, use "renamedArcs" to rename it rather than retiring and creating a new one.
- If two arcs converge into one thread, rename the broader arc and retire the narrower one.
- Only use "retiredArcs" for arcs that are truly finished with no continuation.
- If the total arc count would exceed 6, you MUST rename/merge at least one.
- Include in "updatedArcs" only arcs that progressed, changed status, or are new this chapter.

Return ONLY a JSON object (no markdown fences, no explanation):
${ARC_DELTA_SCHEMA}`;
}

function arcsSummary(arcs: AnalysisResult['arcs']): string {
  if (!arcs?.length) return 'No arcs identified yet.';
  return arcs.map((a) => `- ${a.name} [${a.status}]: ${a.summary}`).join('\n');
}

function buildCharactersFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  text: string,
  schema = CHARACTER_SCHEMA,
): string {
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

TEXT:
${text}

Extract a COMPLETE character roster — every named character who appears, from major protagonists to characters who appear in a single scene. Do not skip anyone because they seem minor.

Return ONLY a JSON object (no markdown fences, no explanation):
${schema}`;
}

function buildCharactersDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  previousCharacters: AnalysisResult['characters'],
  text: string,
  schema = CHARACTER_DELTA_SCHEMA,
): string {
  const prevCount = previousCharacters.length;
  const charLines = previousCharacters
    .map((c) => {
      const aliasStr = c.aliases?.length ? ` [aliases: ${c.aliases.join(', ')}]` : '';
      return `- ${c.name}${aliasStr} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`;
    })
    .join('\n');
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

EXISTING CHARACTERS (${prevCount} already tracked — DO NOT reproduce this list in your output):
${charLines}

NEW CHAPTER TEXT:
${text}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
1. For each character who APPEARS in the new chapter: include them in "updatedCharacters" with updated fields (status, currentLocation, recentEvents, lastSeen). Keep description/relationships from existing state unless the chapter changes them.
2. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in. NEVER group individuals — each person gets their own entry.
3. Do NOT include characters from the existing list who do not appear in the new chapter.
4. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.
5. When returning an existing character in "updatedCharacters", you MUST use their EXACT NAME from the existing list above. Do NOT use a shortened form, nickname, or alternate spelling — copy the name exactly as written.
6. ONLY include characters whose name or alias literally appears in the new chapter text below. Do NOT hallucinate characters.

Return ONLY a JSON object (no markdown fences, no explanation):
${schema}`;
}

function charactersSummary(chars: AnalysisResult['characters']): string {
  if (!chars?.length) return 'No characters yet.';
  return chars
    .map((c) => `- ${c.name} (loc: ${c.currentLocation ?? 'Unknown'}, status: ${c.status})`)
    .join('\n');
}

function locationsSummary(locs: AnalysisResult['locations']): string {
  if (!locs?.length) return 'No locations yet.';
  return locs.map((l) => `- ${l.name}: ${l.description ?? 'No description yet'}`).join('\n');
}

function buildLocationsFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  characters: AnalysisResult['characters'],
  text: string,
  allChapterTitles?: string[],
  schema = LOCATION_SCHEMA,
): string {
  const tocBlock = allChapterTitles && allChapterTitles.length > 1
    ? `\nTABLE OF CONTENTS:\n${allChapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".
${tocBlock}
CHARACTERS AND THEIR CURRENT LOCATIONS (for cross-referencing):
${charactersSummary(characters)}

TEXT:
${text}

Extract all significant named locations from this text. Also write a story summary.

LOCATION RULES:
- Prefer broad canonical place names (city, castle, planet, ship) over sub-locations (rooms, corridors, hallways).
- If a place is inside or part of another location already listed, use the containing location's name instead.
- Include aliases — common shorter names readers might use for the same place.

Return ONLY a JSON object (no markdown fences, no explanation):
${schema}`;
}

function buildLocationsDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  characters: AnalysisResult['characters'],
  previousLocations: AnalysisResult['locations'],
  text: string,
  schema = LOCATION_DELTA_SCHEMA,
): string {
  const existingLocs = (previousLocations ?? []).map((l) => l.name).filter(Boolean);
  const locLine = existingLocs.length > 0
    ? `\nEXISTING LOCATIONS (${existingLocs.length} already tracked — reuse the exact name if a new location is the same place, nearby, or contained within one of these): ${existingLocs.join(', ')}`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

CHARACTERS AND THEIR CURRENT LOCATIONS (for cross-referencing):
${charactersSummary(characters)}
${locLine}

NEW CHAPTER TEXT:
${text}

For significant named places in this chapter: include them in "updatedLocations". CONSOLIDATION RULES:
- If the place is inside or part of an existing location (e.g. a room in a castle, a district of a city), use the existing location name instead.
- If the place is immediately adjacent to or commonly grouped with an existing location, use the existing location name.
- Only add a genuinely new entry if the place is distinct and would appear as a separate node on a map.
Also write an updated story summary.

Return ONLY a JSON object (no markdown fences, no explanation):
${schema}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normLoc(name: string): string {
  return name.toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .split(',')[0].trim()
    .split(/\s+/).sort().join(' ');
}

/** Deduplicate locations, merging prefix-word subsets and alias matches. */
function deduplicateLocations(locs: AnalysisResult['locations']): AnalysisResult['locations'] {
  if (!locs?.length) return locs;
  type LocRel = { location: string; relationship: string };
  type Entry = { canonical: string; aliases: string[]; description: string; arc?: string; recentEvents?: string; relationships: LocRel[]; parentLocation?: string };
  function mergeRels(a: LocRel[], b: LocRel[]): LocRel[] {
    const seen = new Map(a.map((r) => [r.location.toLowerCase(), r]));
    for (const r of b) if (!seen.has(r.location.toLowerCase())) seen.set(r.location.toLowerCase(), r);
    return [...seen.values()];
  }
  function mergeAliases(a: string[], b: string[], canonical: string): string[] {
    const set = new Set([...a, ...b].map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== canonical.toLowerCase()));
    return [...set];
  }

  const groups = new Map<string, Entry>();
  const aliasLookup = new Map<string, string>();

  function findGroupKey(name: string, aliases: string[]): string | undefined {
    const nk = normLoc(name);
    if (groups.has(nk)) return nk;
    if (aliasLookup.has(nk)) return aliasLookup.get(nk);
    for (const a of aliases) {
      const na = normLoc(a);
      if (groups.has(na)) return na;
      if (aliasLookup.has(na)) return aliasLookup.get(na);
    }
    return undefined;
  }

  function registerAliases(groupKey: string, name: string, aliases: string[]) {
    aliasLookup.set(normLoc(name), groupKey);
    for (const a of aliases) aliasLookup.set(normLoc(a), groupKey);
  }

  for (const loc of locs) {
    const locAliases = loc.aliases ?? [];
    const existingKey = findGroupKey(loc.name, locAliases);
    if (existingKey) {
      const existing = groups.get(existingKey)!;
      if (loc.name.length > existing.canonical.length) existing.canonical = loc.name;
      existing.aliases = mergeAliases(existing.aliases, locAliases, existing.canonical);
      if (loc.description.length > existing.description.length) existing.description = loc.description;
      if (!existing.arc && loc.arc) existing.arc = loc.arc;
      if (loc.recentEvents && (!existing.recentEvents || loc.recentEvents.length > existing.recentEvents.length)) existing.recentEvents = loc.recentEvents;
      if (loc.relationships?.length) existing.relationships = mergeRels(existing.relationships, loc.relationships);
      if (!existing.parentLocation && loc.parentLocation) existing.parentLocation = loc.parentLocation;
      registerAliases(existingKey, loc.name, locAliases);
    } else {
      const key = normLoc(loc.name);
      const entry: Entry = { canonical: loc.name, aliases: locAliases, description: loc.description, arc: loc.arc, recentEvents: loc.recentEvents, relationships: loc.relationships ?? [], parentLocation: loc.parentLocation };
      groups.set(key, entry);
      registerAliases(key, loc.name, locAliases);
    }
  }

  // Merge prefix-word subsets: "eros" merges into "eros station"
  const keys = [...groups.keys()];
  for (const shorter of keys) {
    if (!groups.has(shorter)) continue;
    for (const longer of keys) {
      if (shorter === longer || !groups.has(longer)) continue;
      if (longer.startsWith(shorter + ' ')) {
        const gs = groups.get(shorter)!;
        const gl = groups.get(longer)!;
        if (gs.canonical.length > gl.canonical.length) gl.canonical = gs.canonical;
        gl.aliases = mergeAliases(gl.aliases, [...gs.aliases, gs.canonical !== gl.canonical ? gs.canonical : ''].filter(Boolean), gl.canonical);
        if (gs.description.length > gl.description.length) gl.description = gs.description;
        if (!gl.arc && gs.arc) gl.arc = gs.arc;
        if (gs.recentEvents && (!gl.recentEvents || gs.recentEvents.length > gl.recentEvents.length)) gl.recentEvents = gs.recentEvents;
        gl.relationships = mergeRels(gl.relationships, gs.relationships);
        if (!gl.parentLocation && gs.parentLocation) gl.parentLocation = gs.parentLocation;
        groups.delete(shorter);
        break;
      }
    }
  }

  // Cross-reference pass: merge any two groups that share a canonical name or alias
  function mergeInto(target: Entry, source: Entry) {
    if (source.canonical.length > target.canonical.length) target.canonical = source.canonical;
    target.aliases = mergeAliases(target.aliases, [...source.aliases, source.canonical !== target.canonical ? source.canonical : ''].filter(Boolean), target.canonical);
    if (source.description.length > target.description.length) target.description = source.description;
    if (!target.arc && source.arc) target.arc = source.arc;
    if (source.recentEvents && (!target.recentEvents || source.recentEvents.length > target.recentEvents.length)) target.recentEvents = source.recentEvents;
    target.relationships = mergeRels(target.relationships, source.relationships);
    if (!target.parentLocation && source.parentLocation) target.parentLocation = source.parentLocation;
  }
  let again = true;
  while (again) {
    again = false;
    outer: for (const [keyA, groupA] of groups) {
      const normsA = new Set([groupA.canonical, ...groupA.aliases].map(normLoc));
      for (const [keyB, groupB] of groups) {
        if (keyA === keyB) continue;
        const normsB = [groupB.canonical, ...groupB.aliases].map(normLoc);
        if (normsB.some((n) => normsA.has(n))) {
          const [keepKey, keep, drop, dropKey] =
            groupA.canonical.length >= groupB.canonical.length
              ? [keyA, groupA, groupB, keyB]
              : [keyB, groupB, groupA, keyA];
          mergeInto(keep, drop);
          registerAliases(keepKey, keep.canonical, keep.aliases);
          groups.delete(dropKey);
          again = true;
          break outer;
        }
      }
    }
  }

  // Fuzzy pass: Levenshtein ≤1 on normalized location names ≥5 chars
  let fuzzyAgain = true;
  while (fuzzyAgain) {
    fuzzyAgain = false;
    const fKeys = [...groups.keys()];
    fuzzyOuter: for (let i = 0; i < fKeys.length; i++) {
      const keyA = fKeys[i];
      if (!groups.has(keyA)) continue;
      for (let j = i + 1; j < fKeys.length; j++) {
        const keyB = fKeys[j];
        if (!groups.has(keyB)) continue;
        if (keyA.length >= 5 && keyB.length >= 5 && keyA[0] === keyB[0] && levenshtein(keyA, keyB) <= 1) {
          const ga = groups.get(keyA)!;
          const gb = groups.get(keyB)!;
          const [keepKey, keep, drop, dropKey] =
            ga.canonical.length >= gb.canonical.length
              ? [keyA, ga, gb, keyB]
              : [keyB, gb, ga, keyA];
          mergeInto(keep, drop);
          registerAliases(keepKey, keep.canonical, keep.aliases);
          groups.delete(dropKey);
          fuzzyAgain = true;
          break fuzzyOuter;
        }
      }
    }
  }

  return [...groups.values()].map(({ canonical, aliases, description, arc, recentEvents, relationships, parentLocation }) => ({
    name: canonical,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(arc ? { arc } : {}),
    description,
    ...(recentEvents ? { recentEvents } : {}),
    ...(relationships.length > 0 ? { relationships } : {}),
    ...(parentLocation ? { parentLocation } : {}),
  }));
}

/** Infer parentLocation from AI-extracted relationships like "part of", "contains", etc. */
function inferParentLocations(locs: NonNullable<AnalysisResult['locations']>): NonNullable<AnalysisResult['locations']> {
  if (!locs?.length) return locs;

  const CHILD_RELS = new Set(['part of', 'within', 'on', 'inside', 'contained by', 'located in', 'located on']);
  const PARENT_RELS = new Set(['contains', 'encompasses', 'includes']);

  // Build name→canonical lookup (case-insensitive, includes aliases)
  const nameToCanonical = new Map<string, string>();
  for (const loc of locs) {
    nameToCanonical.set(loc.name.toLowerCase().trim(), loc.name);
    for (const a of loc.aliases ?? []) nameToCanonical.set(a.toLowerCase().trim(), loc.name);
  }

  // Collect inferred parents: childName → parentCanonicalName
  const inferred = new Map<string, string>();

  for (const loc of locs) {
    for (const rel of loc.relationships ?? []) {
      const relType = rel.relationship.toLowerCase().trim();
      const targetCanonical = nameToCanonical.get(rel.location.toLowerCase().trim());
      if (!targetCanonical) continue;

      if (CHILD_RELS.has(relType) && targetCanonical !== loc.name && !inferred.has(loc.name)) {
        inferred.set(loc.name, targetCanonical);
      } else if (PARENT_RELS.has(relType) && targetCanonical !== loc.name && !inferred.has(targetCanonical)) {
        inferred.set(targetCanonical, loc.name);
      }
    }
  }

  // Apply — don't overwrite existing parentLocation
  return locs.map((loc) => {
    if (loc.parentLocation || !inferred.has(loc.name)) return loc;
    return { ...loc, parentLocation: inferred.get(loc.name) };
  });
}

/**
 * Strip junk aliases: too-short, cross-contaminated with other characters'
 * primary names, duplicates of own name, and generic titles shared by 3+ chars.
 */
function sanitizeCharacterAliases(chars: AnalysisResult['characters']): AnalysisResult['characters'] {
  const norm = (s: string) => s.toLowerCase().trim();
  const primaryNames = new Set(chars.map((c) => norm(c.name)));

  // Count how many characters use each alias to detect generic titles
  const aliasCounts = new Map<string, number>();
  for (const c of chars) {
    for (const a of c.aliases ?? []) {
      const key = norm(a);
      aliasCounts.set(key, (aliasCounts.get(key) ?? 0) + 1);
    }
  }

  return chars.map((c) => {
    const ownName = norm(c.name);
    const cleaned = (c.aliases ?? []).filter((a) => {
      const an = norm(a);
      if (an.length < 2) return false;           // too short
      if (an === ownName) return false;           // same as own primary name
      if (primaryNames.has(an) && an !== ownName) return false; // another character's primary name
      if ((aliasCounts.get(an) ?? 0) >= 3) return false;       // generic title shared by 3+
      return true;
    });
    return { ...c, aliases: cleaned };
  });
}


/**
 * Multi-strategy character dedup. Returns deduplicated characters + a nameMap
 * mapping every absorbed name/alias (lowercased) → canonical name, so callers
 * can fix relationship targets and arc character lists.
 *
 * Matching passes (iterative — restart on any merge):
 *   1. Exact primary name (case-insensitive)
 *   2. Alias cross-match: A's alias = B's primary name
 *   3. Word-boundary substring (≥4 chars)
 *   4. Levenshtein ≤1 on primary names ≥5 chars, first char must match
 */
function deduplicateCharacters(
  chars: AnalysisResult['characters'],
): { characters: AnalysisResult['characters']; nameMap: Map<string, string> } {
  const norm = (s: string) => s.toLowerCase().trim();

  type CharEntry = AnalysisResult['characters'][0];

  // Clone so we can mutate
  let entries: CharEntry[] = chars.map((c) => ({ ...c }));
  const nameMap = new Map<string, string>();

  function mergeTwo(keep: CharEntry, drop: CharEntry): CharEntry {
    // Name: longer/fuller canonical; prefer uppercase-starting if tied
    let canonical: string;
    if (keep.name.length !== drop.name.length) {
      canonical = keep.name.length >= drop.name.length ? keep.name : drop.name;
    } else {
      canonical = /^[A-Z]/.test(keep.name) ? keep.name : drop.name;
    }

    // Aliases: union all names from both entries, excluding canonical
    const allNames = new Set(
      [keep.name, drop.name, ...(keep.aliases ?? []), ...(drop.aliases ?? [])]
        .map((s) => s.trim())
        .filter((s) => s && norm(s) !== norm(canonical)),
    );

    // Importance: higher wins
    const impOrder: Record<string, number> = { main: 3, secondary: 2, minor: 1 };
    const importance =
      (impOrder[drop.importance] ?? 0) > (impOrder[keep.importance] ?? 0)
        ? drop.importance
        : keep.importance;

    // Description: longer wins
    const description =
      (drop.description?.length ?? 0) > (keep.description?.length ?? 0)
        ? drop.description
        : keep.description;

    // Relationships: merge by character name, longer description wins
    const relationships = mergeCharRelationships(
      keep.relationships ?? [],
      drop.relationships ?? [],
    );

    // Status/lastSeen/currentLocation/recentEvents: prefer entry with more content
    const status =
      drop.status && drop.status !== 'unknown' && (!keep.status || keep.status === 'unknown')
        ? drop.status
        : keep.status;
    const lastSeen =
      (drop.lastSeen?.length ?? 0) > (keep.lastSeen?.length ?? 0)
        ? drop.lastSeen
        : keep.lastSeen;
    const currentLocation =
      drop.currentLocation &&
      drop.currentLocation !== 'Unknown' &&
      (!keep.currentLocation || keep.currentLocation === 'Unknown')
        ? drop.currentLocation
        : keep.currentLocation;
    const recentEvents =
      (drop.recentEvents?.length ?? 0) > (keep.recentEvents?.length ?? 0)
        ? drop.recentEvents
        : keep.recentEvents;

    return {
      ...keep,
      ...drop,
      name: canonical,
      aliases: [...allNames],
      importance,
      description,
      relationships,
      status,
      lastSeen,
      currentLocation,
      recentEvents,
    };
  }

  // Iterative matching — restart on any merge
  let merged = true;
  while (merged) {
    merged = false;

    // Pass 1: Exact primary name (case-insensitive)
    for (let i = 0; i < entries.length && !merged; i++) {
      for (let j = i + 1; j < entries.length && !merged; j++) {
        if (norm(entries[i].name) === norm(entries[j].name)) {
          const result = mergeTwo(entries[i], entries[j]);
          // Record absorbed names
          for (const n of [entries[j].name, ...(entries[j].aliases ?? [])]) {
            nameMap.set(norm(n), result.name);
          }
          for (const n of [entries[i].name, ...(entries[i].aliases ?? [])]) {
            nameMap.set(norm(n), result.name);
          }
          entries[i] = result;
          entries.splice(j, 1);
          merged = true;
        }
      }
    }
    if (merged) continue;

    // Pass 2: Alias cross-match — A's alias = B's primary name
    for (let i = 0; i < entries.length && !merged; i++) {
      const iAliases = new Set((entries[i].aliases ?? []).map(norm));
      for (let j = i + 1; j < entries.length && !merged; j++) {
        const jAliases = new Set((entries[j].aliases ?? []).map(norm));
        if (iAliases.has(norm(entries[j].name)) || jAliases.has(norm(entries[i].name))) {
          const result = mergeTwo(entries[i], entries[j]);
          for (const n of [entries[j].name, ...(entries[j].aliases ?? [])]) {
            nameMap.set(norm(n), result.name);
          }
          for (const n of [entries[i].name, ...(entries[i].aliases ?? [])]) {
            nameMap.set(norm(n), result.name);
          }
          entries[i] = result;
          entries.splice(j, 1);
          merged = true;
        }
      }
    }
    if (merged) continue;

    // Pass 3: Word-boundary substring (≥4 chars)
    for (let i = 0; i < entries.length && !merged; i++) {
      for (let j = i + 1; j < entries.length && !merged; j++) {
        const nameI = entries[i].name;
        const nameJ = entries[j].name;
        const shorter = nameI.length <= nameJ.length ? nameI : nameJ;
        const longer = nameI.length <= nameJ.length ? nameJ : nameI;
        if (shorter.length >= 4) {
          const pattern = new RegExp(`\\b${escapeRegex(shorter)}\\b`, 'i');
          if (pattern.test(longer)) {
            // Keep the longer/fuller name entry as the base
            const [keepIdx, dropIdx] =
              nameI.length >= nameJ.length ? [i, j] : [j, i];
            const result = mergeTwo(entries[keepIdx], entries[dropIdx]);
            for (const n of [entries[dropIdx].name, ...(entries[dropIdx].aliases ?? [])]) {
              nameMap.set(norm(n), result.name);
            }
            for (const n of [entries[keepIdx].name, ...(entries[keepIdx].aliases ?? [])]) {
              nameMap.set(norm(n), result.name);
            }
            entries[keepIdx] = result;
            entries.splice(dropIdx, 1);
            merged = true;
          }
        }
      }
    }
    if (merged) continue;

    // Pass 4: Levenshtein ≤1 on primary names ≥5 chars, first char must match
    for (let i = 0; i < entries.length && !merged; i++) {
      for (let j = i + 1; j < entries.length && !merged; j++) {
        const ni = norm(entries[i].name);
        const nj = norm(entries[j].name);
        if (ni.length >= 5 && nj.length >= 5 && ni[0] === nj[0]) {
          if (levenshtein(ni, nj) <= 1) {
            const result = mergeTwo(entries[i], entries[j]);
            for (const n of [entries[j].name, ...(entries[j].aliases ?? [])]) {
              nameMap.set(norm(n), result.name);
            }
            for (const n of [entries[i].name, ...(entries[i].aliases ?? [])]) {
              nameMap.set(norm(n), result.name);
            }
            entries[i] = result;
            entries.splice(j, 1);
            merged = true;
          }
        }
      }
    }
  }

  // Apply nameMap to all relationship targets
  entries = entries.map((c) => ({
    ...c,
    relationships: (c.relationships ?? []).map((r) => ({
      ...r,
      character: nameMap.get(norm(r.character)) ?? r.character,
    })),
  }));

  if (nameMap.size > 0) {
    console.log(`[analyze] deduplicateCharacters: merged ${chars.length} → ${entries.length} characters`);
  }

  return { characters: entries, nameMap };
}

/**
 * Deduplicate arcs by name similarity.
 *
 * Matching passes (iterative):
 *   1. Exact name (case-insensitive)
 *   2. Word-boundary containment: entire shorter name appears at word boundaries in longer
 */
function deduplicateArcs(arcs: AnalysisResult['arcs']): AnalysisResult['arcs'] {
  if (!arcs?.length) return arcs;
  const norm = (s: string) => s.toLowerCase().trim();

  type ArcEntry = NonNullable<AnalysisResult['arcs']>[0];
  let entries: ArcEntry[] = arcs.map((a) => ({ ...a }));

  const statusOrder: Record<string, number> = { active: 3, dormant: 2, resolved: 1 };

  function mergeTwo(a: ArcEntry, b: ArcEntry): ArcEntry {
    // Name: shorter/broader name (the one that the other contains)
    const name = a.name.length <= b.name.length ? a.name : b.name;
    // Status: prefer active > dormant > resolved
    const status =
      (statusOrder[b.status] ?? 0) > (statusOrder[a.status] ?? 0) ? b.status : a.status;
    // Characters: union (deduplicated)
    const characters = [...new Set([...a.characters, ...b.characters])];
    // Summary: longer
    const summary =
      (b.summary?.length ?? 0) > (a.summary?.length ?? 0) ? b.summary : a.summary;
    return { name, status, characters, summary };
  }

  let merged = true;
  while (merged) {
    merged = false;

    // Pass 1: Exact name (case-insensitive)
    for (let i = 0; i < entries.length && !merged; i++) {
      for (let j = i + 1; j < entries.length && !merged; j++) {
        if (norm(entries[i].name) === norm(entries[j].name)) {
          entries[i] = mergeTwo(entries[i], entries[j]);
          entries.splice(j, 1);
          merged = true;
        }
      }
    }
    if (merged) continue;

    // Pass 2: Word-boundary containment — entire shorter name at word boundaries in longer
    for (let i = 0; i < entries.length && !merged; i++) {
      for (let j = i + 1; j < entries.length && !merged; j++) {
        const shorter = entries[i].name.length <= entries[j].name.length ? entries[i].name : entries[j].name;
        const longerIdx = entries[i].name.length <= entries[j].name.length ? j : i;
        const longer = entries[longerIdx].name;
        if (shorter.length >= 4) {
          const pattern = new RegExp(`\\b${escapeRegex(shorter)}\\b`, 'i');
          if (pattern.test(longer)) {
            entries[i] = mergeTwo(entries[i], entries[j]);
            entries.splice(j, 1);
            merged = true;
          }
        }
      }
    }
  }

  if (entries.length < arcs.length) {
    console.log(`[analyze] deduplicateArcs: merged ${arcs.length} → ${entries.length} arcs`);
  }

  return entries;
}


/** After arcs are identified, assign arc labels to locations based on character-arc overlap. */
function assignArcsToLocations(
  locations: AnalysisResult['locations'],
  arcs: AnalysisResult['arcs'],
  characters: AnalysisResult['characters'],
): AnalysisResult['locations'] {
  if (!locations?.length || !arcs?.length) return locations;
  const norm = (s: string) => s.toLowerCase().trim();
  return locations.map((loc) => {
    const locNames = new Set([loc.name, ...(loc.aliases ?? [])].map(norm));
    // Find characters whose currentLocation matches this location
    const charsHere = characters.filter((c) =>
      c.currentLocation && locNames.has(norm(c.currentLocation)),
    );
    // Find the arc with the most character overlap at this location
    let bestArc: string | undefined;
    let bestCount = 0;
    for (const arc of arcs) {
      const arcCharSet = new Set((arc.characters ?? []).map(norm));
      const count = charsHere.filter((c) =>
        arcCharSet.has(norm(c.name)) || c.aliases?.some((a) => arcCharSet.has(norm(a))),
      ).length;
      if (count > bestCount) { bestCount = count; bestArc = arc.name; }
    }
    // Fallback: check if arc summary mentions the location name
    if (!bestArc) {
      for (const arc of arcs) {
        if (locNames.has(norm(arc.name)) || norm(arc.summary).includes(norm(loc.name))) {
          bestArc = arc.name;
          break;
        }
      }
    }
    return bestArc ? { ...loc, arc: bestArc } : loc;
  });
}

const MAX_ARCS = 8;

const IMPORTANCE_ORDER: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

function mergeCharRelationships(
  existing: { character: string; relationship: string }[],
  incoming: { character: string; relationship: string }[],
): { character: string; relationship: string }[] {
  const seen = new Map(existing.map((r) => [r.character.toLowerCase(), r]));
  for (const r of incoming) {
    const key = r.character.toLowerCase();
    const prev = seen.get(key);
    if (!prev || r.relationship.length > prev.relationship.length) {
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}

function mergeLocRelationships(
  existing: { location: string; relationship: string }[],
  incoming: { location: string; relationship: string }[],
): { location: string; relationship: string }[] {
  const seen = new Map(existing.map((r) => [r.location.toLowerCase(), r]));
  for (const r of incoming) {
    const key = r.location.toLowerCase();
    const prev = seen.get(key);
    if (!prev || r.relationship.length > prev.relationship.length) {
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}

function mergeDelta(
  previous: AnalysisResult,
  delta: { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; updatedArcs?: AnalysisResult['arcs']; renamedArcs?: { from: string; to: string }[]; retiredArcs?: string[]; summary?: string },
): AnalysisResult {
  const merged = previous.characters.map((c) => ({ ...c }));
  for (const updated of delta.updatedCharacters ?? []) {
    if (!updated.name) continue;
    // Match by primary name first (strongest signal), then by name/alias with ambiguity check.
    // If a name matches multiple existing characters (e.g. shared title "Lord Commander"),
    // skip the merge to avoid combining distinct characters.
    let idx = merged.findIndex((c) => c.name.toLowerCase().trim() === updated.name.toLowerCase().trim());
    if (idx < 0) {
      const updatedNames = new Set([updated.name, ...(updated.aliases ?? [])].map((n) => n.toLowerCase().trim()));
      const candidates: number[] = [];
      for (let i = 0; i < merged.length; i++) {
        if ([merged[i].name, ...(merged[i].aliases ?? [])].some((n) => updatedNames.has(n.toLowerCase().trim()))) {
          candidates.push(i);
        }
      }
      if (candidates.length === 1) {
        idx = candidates[0];
      } else if (candidates.length > 1) {
        console.log(`[analyze] Ambiguous match for "${updated.name}" — matches ${candidates.map(i => `"${merged[i].name}"`).join(', ')}. Adding as new entry.`);
      }
    }
    if (idx >= 0) {
      const existing = merged[idx];
      const canonicalName = updated.name.length >= existing.name.length ? updated.name : existing.name;
      const allAliases = [...new Set([
        ...(existing.aliases ?? []),
        ...(updated.aliases ?? []),
        updated.name !== canonicalName ? updated.name : '',
        existing.name !== canonicalName ? existing.name : '',
      ].map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== canonicalName.toLowerCase()))];
      // Intelligent field merging instead of shallow spread
      const mergedRels = mergeCharRelationships(existing.relationships ?? [], updated.relationships ?? []);
      const mergedDesc = (updated.description?.length ?? 0) > (existing.description?.length ?? 0)
        ? updated.description : existing.description;
      const mergedImportance = (IMPORTANCE_ORDER[updated.importance] ?? 0) > (IMPORTANCE_ORDER[existing.importance] ?? 0)
        ? updated.importance : existing.importance;
      const mergedRecent = updated.recentEvents || existing.recentEvents;
      merged[idx] = {
        ...existing, ...updated,
        name: canonicalName, aliases: allAliases,
        relationships: mergedRels, description: mergedDesc,
        importance: mergedImportance, recentEvents: mergedRecent,
      };
    } else {
      merged.push(updated);
    }
  }

  const prevLocations = previous.locations ?? [];
  const mergedLocations = [...prevLocations];
  for (const updated of delta.updatedLocations ?? []) {
    if (!updated.name) continue;
    const updatedLocNorms = new Set([updated.name, ...(updated.aliases ?? [])].map(normLoc));
    const idx = mergedLocations.findIndex((l) =>
      [l.name, ...(l.aliases ?? [])].some((n) => updatedLocNorms.has(normLoc(n))),
    );
    if (idx >= 0) {
      const existing = mergedLocations[idx];
      const canonicalName = updated.name.length >= existing.name.length ? updated.name : existing.name;
      const allAliases = [...new Set([
        ...(existing.aliases ?? []),
        ...(updated.aliases ?? []),
        updated.name !== canonicalName ? updated.name : '',
        existing.name !== canonicalName ? existing.name : '',
      ].map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== canonicalName.toLowerCase()))];
      const mergedLocRels = mergeLocRelationships(existing.relationships ?? [], updated.relationships ?? []);
      const mergedLocDesc = (updated.description?.length ?? 0) > (existing.description?.length ?? 0)
        ? updated.description : existing.description;
      mergedLocations[idx] = {
        ...existing, ...updated,
        name: canonicalName, aliases: allAliases.length > 0 ? allAliases : undefined,
        relationships: mergedLocRels.length > 0 ? mergedLocRels : undefined,
        description: mergedLocDesc,
      };
    } else {
      mergedLocations.push(updated);
    }
  }

  const retired = new Set((delta.retiredArcs ?? []).map((n) => n.toLowerCase()));
  let prevArcs = (previous.arcs ?? []).filter((a) => !retired.has(a.name.toLowerCase()));
  for (const { from, to } of delta.renamedArcs ?? []) {
    const idx = prevArcs.findIndex((a) => a.name.toLowerCase() === from.toLowerCase());
    if (idx >= 0) prevArcs = prevArcs.map((a, i) => i === idx ? { ...a, name: to } : a);
    else console.warn(`[analyze] renamedArcs: arc "${from}" not found`);
  }
  const mergedArcs = [...prevArcs];
  for (const updated of delta.updatedArcs ?? []) {
    if (!updated.name || retired.has(updated.name.toLowerCase())) continue;
    const idx = mergedArcs.findIndex((a) => a.name.toLowerCase() === updated.name.toLowerCase());
    if (idx >= 0) {
      mergedArcs[idx] = { ...mergedArcs[idx], ...updated };
    } else {
      mergedArcs.push(updated);
    }
  }
  if (mergedArcs.length > MAX_ARCS) {
    const order = { resolved: 0, dormant: 1, active: 2 };
    mergedArcs.sort((a, b) => order[a.status] - order[b.status]);
    mergedArcs.splice(0, mergedArcs.length - MAX_ARCS);
  }

  return {
    characters: merged,
    locations: mergedLocations.length > 0 ? mergedLocations : undefined,
    arcs: mergedArcs.length > 0 ? mergedArcs : undefined,
    summary: delta.summary ?? previous.summary,
  };
}

// ─── LLM config type ─────────────────────────────────────────────────────────

type AnalyzeConfig = Omit<import('@/lib/llm').LLMCallConfig, 'system' | 'userPrompt' | 'maxTokens'>;

/** Extract individual JSON objects from an array field in potentially truncated JSON. */
function extractJsonArray(raw: string, fieldName: string): unknown[] {
  const key = `"${fieldName}"`;
  const keyPos = raw.indexOf(key);
  if (keyPos === -1) return [];
  const bracketStart = raw.indexOf('[', keyPos);
  if (bracketStart === -1) return [];

  const items: unknown[] = [];
  let i = bracketStart + 1;
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i])) i++;
    if (i >= raw.length || raw[i] !== '{') break;
    let depth = 0, j = i, inString = false, escape = false;
    while (j < raw.length) {
      const ch = raw[j];
      if (escape) { escape = false; j++; continue; }
      if (ch === '\\' && inString) { escape = true; j++; continue; }
      if (ch === '"') { inString = !inString; j++; continue; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      j++;
    }
    if (depth !== 0) break; // truncated mid-object — stop here
    try { items.push(JSON.parse(raw.slice(i, j))); } catch { /* skip malformed */ }
    i = j;
  }
  return items;
}

/** Try to recover a response from truncated JSON by extracting known array fields individually. */
function recoverPartialResponse(raw: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const arrayFields = [
    'characters', 'updatedCharacters',
    'locations', 'updatedLocations',
    'arcs', 'updatedArcs',
    'verdicts', 'mergeGroups', 'splits',
  ];
  for (const field of arrayFields) {
    const items = extractJsonArray(raw, field);
    if (items.length > 0) result[field] = items;
  }
  const summaryMatch = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (summaryMatch) result.summary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return Object.keys(result).length > 0 ? result : null;
}

/** When an LLM response is truncated, ask the model to continue extracting entities it missed. */
async function attemptOutputContinuation<T>(
  system: string,
  originalPrompt: string,
  config: AnalyzeConfig,
  label: string,
  partialResult: Record<string, unknown>,
  maxTokens: number,
): Promise<{ result: T | null; rateLimitWaitMs: number }> {
  let totalRateLimitMs = 0;
  let accumulated = { ...partialResult };

  for (let contPass = 0; contPass < 3; contPass++) {
    // Build a list of already-found entity names to exclude
    const foundNames: string[] = [];
    for (const key of ['characters', 'updatedCharacters', 'locations', 'updatedLocations', 'arcs', 'updatedArcs']) {
      const arr = accumulated[key];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === 'object' && 'name' in item) foundNames.push((item as { name: string }).name);
        }
      }
    }

    if (foundNames.length === 0) break;

    const continuationPrompt = `Your previous response was truncated. You already found these ${foundNames.length} entities: ${foundNames.join(', ')}.

Continue extracting from the SAME text provided earlier. Return ONLY entities you have NOT already listed above. Use the exact same JSON schema. If there are no additional entities, return an empty result.

Original instructions (for reference — do NOT repeat entities listed above):
${originalPrompt.slice(0, 2000)}`;

    console.log(`[analyze] ${label}: output truncated, continuation pass ${contPass + 1} (already found ${foundNames.length} entities)`);

    const { text: contRaw, truncated: contTruncated, rateLimitWaitMs } = await callLLM({
      ...config, system, userPrompt: continuationPrompt, maxTokens, jsonMode: true,
    });
    if (rateLimitWaitMs) totalRateLimitMs += rateLimitWaitMs;

    let contCleaned = contRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const fb = contCleaned.indexOf('{');
    const lb = contCleaned.lastIndexOf('}');
    if (fb >= 0 && lb > fb) contCleaned = contCleaned.slice(fb, lb + 1);

    let contParsed: Record<string, unknown> | null = null;
    try {
      contParsed = JSON.parse(contCleaned);
    } catch {
      contParsed = recoverPartialResponse(contCleaned);
    }

    if (!contParsed) break;

    // Merge continuation arrays into accumulated result
    let addedAny = false;
    for (const key of ['characters', 'updatedCharacters', 'locations', 'updatedLocations', 'arcs', 'updatedArcs', 'verdicts', 'mergeGroups', 'splits']) {
      const contArr = contParsed[key];
      if (Array.isArray(contArr) && contArr.length > 0) {
        const existing = accumulated[key];
        accumulated[key] = Array.isArray(existing) ? [...existing, ...contArr] : contArr;
        addedAny = true;
      }
    }
    if (contParsed.summary && !accumulated.summary) accumulated.summary = contParsed.summary;

    if (!addedAny || !contTruncated) break;
  }

  return { result: accumulated as T, rateLimitWaitMs: totalRateLimitMs };
}

async function callAndParseJSON<T>(
  system: string,
  userPrompt: string,
  config: AnalyzeConfig,
  label: string,
  maxTokens?: number,
  contextWindow?: number,
): Promise<{ result: T | null; rateLimitWaitMs: number }> {
  let totalRateLimitMs = 0;

  // Dynamic output token scaling: scale based on input size, capped by context window
  const inputChars = userPrompt.length + (system?.length ?? 0);
  const scaledTokens = Math.max(maxTokens ?? 16384, Math.ceil(inputChars / 20));
  const effectiveMaxTokens = contextWindow
    ? Math.min(scaledTokens, Math.floor(contextWindow * 0.4))
    : scaledTokens;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text: raw, truncated, rateLimitWaitMs } = await callLLM({
      ...config, system, userPrompt,
      maxTokens: effectiveMaxTokens,
      jsonMode: true,
    });
    if (rateLimitWaitMs) totalRateLimitMs += rateLimitWaitMs;

    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);

    try {
      return { result: JSON.parse(cleaned) as T, rateLimitWaitMs: totalRateLimitMs };
    } catch {
      const recovered = recoverPartialResponse(cleaned);
      if (recovered && Object.keys(recovered).length > 0) {
        console.log(`[analyze] ${label}: recovered partial JSON (keys: ${Object.keys(recovered).join(', ')})`);

        // If truncated, try continuation: ask the model to find additional entities
        if (truncated) {
          const continuationResult = await attemptOutputContinuation<T>(
            system, userPrompt, config, label, recovered, effectiveMaxTokens,
          );
          if (continuationResult.rateLimitWaitMs) totalRateLimitMs += continuationResult.rateLimitWaitMs;
          if (continuationResult.result) {
            return { result: continuationResult.result, rateLimitWaitMs: totalRateLimitMs };
          }
        }

        return { result: recovered as T, rateLimitWaitMs: totalRateLimitMs };
      }
      if (attempt === 0) {
        console.warn(`[analyze] ${label}: parse failed, retrying…`);
      } else {
        console.warn(`[analyze] ${label}: all attempts failed. Preview:`, cleaned.slice(-200));
      }
    }
  }
  return { result: null, rateLimitWaitMs: totalRateLimitMs };
}

// ─── Multi-pass analysis ──────────────────────────────────────────────────────

interface ArcDeltaResult {
  updatedArcs?: AnalysisResult['arcs'];
  renamedArcs?: { from: string; to: string }[];
  retiredArcs?: string[];
}

interface CharDeltaResult {
  updatedCharacters?: AnalysisResult['characters'];
}

interface LocResult {
  locations?: AnalysisResult['locations'];
  summary?: string;
}

interface LocDeltaResult {
  updatedLocations?: AnalysisResult['locations'];
  summary?: string;
}

async function runMultiPassFull(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  text: string,
  allChapterTitles: string[] | undefined,
  config: AnalyzeConfig,
  contextWindow?: number,
): Promise<{ result: AnalysisResult; totalRateLimitMs: number }> {
  let totalRateLimitMs = 0;

  // Pass 1: Characters
  console.log('[analyze] Pass 1: characters');
  const charSystem = config.provider === 'ollama' ? CHARACTERS_SYSTEM_LOCAL : CHARACTERS_SYSTEM;
  const charSchema = config.provider === 'ollama' ? CHARACTER_SCHEMA_LOCAL : CHARACTER_SCHEMA;
  const { result: charsResult, rateLimitWaitMs: rlChars } = await callAndParseJSON<{ characters?: AnalysisResult['characters'] }>(
    charSystem,
    buildCharactersFullPrompt(bookTitle, bookAuthor, chapterTitle, text, charSchema),
    config, 'characters-full', config.provider === 'ollama' ? 16384 : undefined, contextWindow,
  );
  totalRateLimitMs += rlChars;
  let characters = charsResult?.characters ?? [];
  characters = sanitizeCharacterAliases(characters);
  const charDedup = deduplicateCharacters(characters);
  characters = charDedup.characters;
  let charNameMap = charDedup.nameMap;
  console.log(`[analyze] Pass 1 done: ${characters.length} characters`);

  // Text grounding: drop characters whose names don't appear in the text
  const { validated: groundedChars, dropped: droppedFull } = validateCharactersAgainstText(characters, text);
  if (droppedFull.length) console.log(`[analyze] Dropped ${droppedFull.length} ungrounded characters: ${droppedFull.join(', ')}`);
  characters = groundedChars;

  // LLM verification pass: review extracted characters against source text (cloud models only)
  if (config.provider !== 'ollama' && characters.length > 0) {
    console.log('[analyze] Verification pass: reviewing characters against text');
    const verifyBudget = contextWindow
      ? computeTextBudget(contextWindow, 4096, buildVerificationPrompt(characters, ''))
      : 80_000;
    const { result: verifyResult, rateLimitWaitMs: rlVerify } = await callAndParseJSON<{ verdicts: Verdict[] }>(
      VERIFICATION_SYSTEM,
      buildVerificationPrompt(characters, text, verifyBudget),
      config, 'char-verify', undefined, contextWindow,
    );
    totalRateLimitMs += rlVerify;
    if (verifyResult?.verdicts?.length) {
      const beforeCount = characters.length;
      characters = applyVerificationVerdicts([...characters], verifyResult.verdicts);
      if (characters.length < beforeCount) {
        console.log(`[analyze] Verification: ${beforeCount} → ${characters.length} characters`);
      }
    }
  }

  // Pass 2: Locations + summary
  console.log('[analyze] Pass 2: locations');
  const locSystem = config.provider === 'ollama' ? LOCATIONS_SYSTEM_LOCAL : LOCATIONS_SYSTEM;
  const locSchema = config.provider === 'ollama' ? LOCATION_SCHEMA_LOCAL : LOCATION_SCHEMA;
  const { result: locsResult, rateLimitWaitMs: rlLocs } = await callAndParseJSON<LocResult>(
    locSystem,
    buildLocationsFullPrompt(bookTitle, bookAuthor, chapterTitle, characters, text, allChapterTitles, locSchema),
    config, 'locations-full', config.provider === 'ollama' ? 8192 : undefined, contextWindow,
  );
  totalRateLimitMs += rlLocs;
  const rawLocations = locsResult?.locations ?? [];
  const summary = locsResult?.summary ?? '';
  console.log(`[analyze] Pass 2 done: ${rawLocations.length} locations`);

  // Text grounding: drop locations whose names don't appear in the text
  const { validated: groundedLocs, dropped: droppedLocs } = validateLocationsAgainstText(rawLocations, text);
  if (droppedLocs.length) console.log(`[analyze] Dropped ${droppedLocs.length} ungrounded locations: ${droppedLocs.join(', ')}`);
  const locations = groundedLocs;

  // Pass 3: Arcs (with full character + location context)
  console.log('[analyze] Pass 3: arcs');
  const arcSystem = config.provider === 'ollama' ? ARCS_SYSTEM_LOCAL : ARCS_SYSTEM;
  const { result: arcsResult, rateLimitWaitMs: rlArcs } = await callAndParseJSON<{ arcs?: AnalysisResult['arcs'] }>(
    arcSystem,
    buildArcsFullPrompt(bookTitle, bookAuthor, chapterTitle, text, characters, locations, allChapterTitles),
    config, 'arcs-full', config.provider === 'ollama' ? 4096 : undefined, contextWindow,
  );
  totalRateLimitMs += rlArcs;
  let arcs = arcsResult?.arcs ?? [];
  // Apply character nameMap to arc character lists, then dedup arcs
  if (charNameMap.size > 0) arcs = updateArcReferences(arcs, charNameMap) ?? arcs;
  arcs = deduplicateArcs(arcs) ?? [];
  console.log(`[analyze] Pass 3 done: ${arcs.length} arcs`);

  // Post-process: assign arc labels to locations, then infer hierarchy from relationships
  const labeledLocations = assignArcsToLocations(locations, arcs, characters) ?? [];
  const hierarchicalLocations = inferParentLocations(labeledLocations);

  // Reconciliation pass
  const assembled: AnalysisResult = { characters, locations: hierarchicalLocations.length > 0 ? hierarchicalLocations : undefined, arcs: arcs.length > 0 ? arcs : undefined, summary };

  // Auto-reconciliation: skip for local models when no name overlaps detected
  const charOverlaps = computeNameOverlaps(assembled.characters);
  const locOverlaps = computeNameOverlaps(assembled.locations ?? []);
  const skipReconcile = config.provider === 'ollama' && charOverlaps.length === 0 && locOverlaps.length === 0;

  let reconciled: AnalysisResult;
  if (skipReconcile) {
    console.log('[analyze] Skipping reconciliation: no name overlaps detected (local model)');
    reconciled = assembled;
  } else {
    console.log('[analyze] Auto-reconciliation pass');
    const callAndParse: CallAndParseFn = async <T>(system: string, userPrompt: string, label: string) => {
      const { result, rateLimitWaitMs: rl } = await callAndParseJSON<T>(system, userPrompt, config, label, config.provider === 'ollama' ? 4096 : undefined, contextWindow);
      totalRateLimitMs += rl;
      return result;
    };
    // Compute text budget for reconciliation excerpts
    const reconcileExcerptBudget = contextWindow
      ? computeTextBudget(contextWindow, 4096, buildCharReconcilePrompt(bookTitle, bookAuthor, assembled.characters))
      : undefined;
    reconciled = await reconcileResult(assembled, bookTitle, bookAuthor, text, callAndParse, reconcileExcerptBudget);
    console.log(`[analyze] Reconciliation complete: ${reconciled.characters.length} chars, ${reconciled.locations?.length ?? 0} locs`);
  }

  // Final location dedup (catches any remaining duplicates after reconciliation)
  reconciled = { ...reconciled, locations: deduplicateLocations(reconciled.locations) };

  return { result: reconciled, totalRateLimitMs };
}

async function runMultiPassDelta(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  text: string,
  previousResult: AnalysisResult,
  config: AnalyzeConfig,
  contextWindow?: number,
): Promise<{ result: AnalysisResult; totalRateLimitMs: number }> {
  let totalRateLimitMs = 0;

  // Pass 1: Characters
  console.log('[analyze] Pass 1: characters (delta)');
  const charSystem = config.provider === 'ollama' ? CHARACTERS_SYSTEM_LOCAL : CHARACTERS_SYSTEM;
  const charDeltaSchema = config.provider === 'ollama' ? CHARACTER_DELTA_SCHEMA_LOCAL : CHARACTER_DELTA_SCHEMA;
  const { result: charsResult, rateLimitWaitMs: rlChars } = await callAndParseJSON<CharDeltaResult>(
    charSystem,
    buildCharactersDeltaPrompt(bookTitle, bookAuthor, chapterTitle, previousResult.characters, text, charDeltaSchema),
    config, 'characters-delta', config.provider === 'ollama' ? 8192 : undefined, contextWindow,
  );
  totalRateLimitMs += rlChars;
  // Text grounding: drop delta characters whose names don't appear in the new chapter text
  let deltaChars = charsResult?.updatedCharacters ?? [];
  deltaChars = sanitizeCharacterAliases(deltaChars);
  const deltaDedup = deduplicateCharacters(deltaChars);
  deltaChars = deltaDedup.characters;
  if (deltaChars.length) {
    const { validated, dropped } = validateCharactersAgainstText(deltaChars, text);
    if (dropped.length) console.log(`[analyze] Dropped ${dropped.length} ungrounded delta characters: ${dropped.join(', ')}`);
    deltaChars = validated;
  }
  // LLM verification pass for delta characters (cloud models only)
  if (config.provider !== 'ollama' && deltaChars.length > 0) {
    console.log('[analyze] Verification pass: reviewing delta characters against text');
    const verifyBudget = contextWindow
      ? computeTextBudget(contextWindow, 4096, buildVerificationPrompt(deltaChars, ''))
      : 80_000;
    const { result: verifyResult, rateLimitWaitMs: rlVerify } = await callAndParseJSON<{ verdicts: Verdict[] }>(
      VERIFICATION_SYSTEM,
      buildVerificationPrompt(deltaChars, text, verifyBudget),
      config, 'char-verify-delta', undefined, contextWindow,
    );
    totalRateLimitMs += rlVerify;
    if (verifyResult?.verdicts?.length) {
      const beforeCount = deltaChars.length;
      deltaChars = applyVerificationVerdicts([...deltaChars], verifyResult.verdicts);
      if (deltaChars.length < beforeCount) {
        console.log(`[analyze] Verification: ${beforeCount} → ${deltaChars.length} delta characters`);
      }
    }
  }
  const charDelta = { updatedCharacters: deltaChars };
  const afterChars = mergeDelta(previousResult, charDelta);

  // Post-merge character dedup: catches cross-chapter duplicates that mergeDelta missed
  const postMergeDedup = deduplicateCharacters(afterChars.characters);
  let currentCharacters = sanitizeCharacterAliases(postMergeDedup.characters);
  const charNameMap = postMergeDedup.nameMap;
  console.log(`[analyze] Pass 1 done: ${deltaChars.length} char changes → ${currentCharacters.length} chars`);

  // Pass 2: Locations + summary
  console.log('[analyze] Pass 2: locations (delta)');
  const locSystem = config.provider === 'ollama' ? LOCATIONS_SYSTEM_LOCAL : LOCATIONS_SYSTEM;
  const locDeltaSchema = config.provider === 'ollama' ? LOCATION_DELTA_SCHEMA_LOCAL : LOCATION_DELTA_SCHEMA;
  const { result: locsResult, rateLimitWaitMs: rlLocs } = await callAndParseJSON<LocDeltaResult>(
    locSystem,
    buildLocationsDeltaPrompt(bookTitle, bookAuthor, chapterTitle, currentCharacters, previousResult.locations, text, locDeltaSchema),
    config, 'locations-delta', config.provider === 'ollama' ? 8192 : undefined, contextWindow,
  );
  totalRateLimitMs += rlLocs;
  const deltaLocs = locsResult?.updatedLocations ?? [];
  const { validated: groundedDeltaLocs, dropped: droppedDeltaLocs } = validateLocationsAgainstText(deltaLocs, text);
  if (droppedDeltaLocs.length) console.log(`[analyze] Dropped ${droppedDeltaLocs.length} ungrounded delta locations: ${droppedDeltaLocs.join(', ')}`);
  const locDelta = { updatedLocations: groundedDeltaLocs, summary: locsResult?.summary };
  const afterLocs = mergeDelta({ ...afterChars, characters: currentCharacters }, locDelta);
  const currentLocations = afterLocs.locations;
  console.log(`[analyze] Pass 2 done: ${locDelta.updatedLocations?.length ?? 0} location changes`);

  // Pass 3: Arcs (with full character + location context)
  console.log('[analyze] Pass 3: arcs (delta)');
  const arcSystem = config.provider === 'ollama' ? ARCS_SYSTEM_LOCAL : ARCS_SYSTEM;
  const { result: arcsResult, rateLimitWaitMs: rlArcs } = await callAndParseJSON<ArcDeltaResult>(
    arcSystem,
    buildArcsDeltaPrompt(bookTitle, bookAuthor, chapterTitle, previousResult.arcs, currentCharacters, currentLocations, text),
    config, 'arcs-delta', config.provider === 'ollama' ? 4096 : undefined, contextWindow,
  );
  totalRateLimitMs += rlArcs;
  const arcDelta = {
    updatedArcs: arcsResult?.updatedArcs,
    renamedArcs: arcsResult?.renamedArcs,
    retiredArcs: arcsResult?.retiredArcs,
  };
  console.log(`[analyze] Pass 3 done: ${arcDelta.updatedArcs?.length ?? 0} arc changes`);

  // Final merge: combine arc deltas into the result that already has chars + locs
  const finalResult = mergeDelta({ ...afterLocs, characters: currentCharacters }, arcDelta);

  // Apply character nameMap to arcs and dedup arcs
  if (charNameMap.size > 0) finalResult.arcs = updateArcReferences(finalResult.arcs, charNameMap);
  finalResult.arcs = deduplicateArcs(finalResult.arcs);

  if (finalResult.locations) finalResult.locations = deduplicateLocations(finalResult.locations);

  // Post-process: assign arc labels to locations, then infer hierarchy from relationships
  const labeledLocations = assignArcsToLocations(finalResult.locations, finalResult.arcs, finalResult.characters) ?? finalResult.locations;
  const hierarchicalLocations = labeledLocations ? inferParentLocations(labeledLocations) : labeledLocations;

  console.log(`[analyze] Delta complete: ${finalResult.characters.length} chars, ${finalResult.arcs?.length ?? 0} arcs, ${finalResult.locations?.length ?? 0} locs`);
  return { result: { ...finalResult, locations: hierarchicalLocations }, totalRateLimitMs };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/** GET /api/analyze — returns the server's AI provider status (no secrets exposed) */
export async function GET() {
  const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
  const usesLocal = process.env.USE_LOCAL_MODEL === 'true';
  return NextResponse.json({
    serverConfigured: hasEnvKey || usesLocal,
    provider: usesLocal ? 'ollama' : (hasEnvKey ? 'anthropic' : null),
    model: usesLocal ? (process.env.LOCAL_MODEL_NAME ?? null) : (hasEnvKey ? null : null),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      chaptersRead?: Array<{ title: string; text: string }>;
      newChapters?: Array<{ title: string; text: string }>;
      allChapterTitles?: string[];
      currentChapterTitle: string;
      bookTitle: string;
      bookAuthor: string;
      previousResult?: AnalysisResult;
      _provider?: 'anthropic' | 'ollama' | 'gemini' | 'openai-compatible';
      _apiKey?: string;
      _ollamaUrl?: string;
      _model?: string;
      _geminiKey?: string;
      _openaiCompatibleUrl?: string;
      _openaiCompatibleKey?: string;
    };
    const { chaptersRead, newChapters, allChapterTitles, currentChapterTitle, bookTitle, bookAuthor, previousResult } = body;

    const config = resolveConfig(body);

    if (config.provider !== 'ollama' && !config.apiKey) {
      return NextResponse.json(
        { error: 'No API key configured. Open Settings to add your key.' },
        { status: 400 },
      );
    }

    const modelName = config.model;

    // Detect context window for this provider/model
    const contextWindow = await getContextWindow(config);
    console.log(`[analyze] Context window: ${contextWindow} tokens (${config.provider}/${config.model})`);

    const isDelta = !!(previousResult && newChapters?.length);
    let result: AnalysisResult;
    let totalRateLimitMs = 0;

    if (isDelta) {
      const newText = newChapters!
        .map((ch) => `=== ${ch.title} ===\n\n${ch.text}`)
        .join('\n\n---\n\n');

      // Estimate conservative budget for Level 1 splitting
      const conservativeOverhead = 6000;
      const outputReserve = 8192;
      const budget = computeTextBudget(contextWindow, outputReserve, 'x'.repeat(conservativeOverhead));
      const chunks = splitChapterText(newText, budget);

      if (chunks.length > 1) {
        console.log(`[analyze] Chapter "${currentChapterTitle}" split into ${chunks.length} chunks (budget: ${budget} chars)`);
        if (contextWindow <= 4096) {
          console.warn(`[analyze] Warning: context window is ${contextWindow} tokens — chapter "${currentChapterTitle}" requires ${chunks.length} chunks. Consider increasing num_ctx for better performance.`);
        }
      }

      let accumulated: AnalysisResult = previousResult!;

      for (const chunk of chunks) {
        if (chunks.length > 1) {
          console.log(`[analyze] Chapter "${currentChapterTitle}" chunk ${chunk.index + 1}/${chunk.total} (${chunk.text.length} chars)`);
        }
        const { result: chunkResult, totalRateLimitMs: chunkRl } = await runMultiPassDelta(
          bookTitle, bookAuthor, currentChapterTitle, chunk.text, accumulated, config, contextWindow,
        );
        totalRateLimitMs += chunkRl;
        accumulated = chunkResult;
      }
      result = accumulated;
    } else {
      if (!chaptersRead?.length) {
        return NextResponse.json({ error: 'No chapter text provided.' }, { status: 400 });
      }
      const fullText = chaptersRead
        .map((ch) => `=== ${ch.title} ===\n\n${ch.text}`)
        .join('\n\n---\n\n');

      const conservativeOverhead = 6000;
      const outputReserve = 8192;
      const budget = computeTextBudget(contextWindow, outputReserve, 'x'.repeat(conservativeOverhead));
      const chunks = splitChapterText(fullText, budget);

      if (chunks.length > 1) {
        console.log(`[analyze] Chapter "${currentChapterTitle}" split into ${chunks.length} chunks (budget: ${budget} chars)`);
        if (contextWindow <= 4096) {
          console.warn(`[analyze] Warning: context window is ${contextWindow} tokens — chapter "${currentChapterTitle}" requires ${chunks.length} chunks. Consider increasing num_ctx for better performance.`);
        }
      }

      // First chunk: full analysis. Subsequent chunks: delta.
      const { result: firstResult, totalRateLimitMs: firstRl } = await runMultiPassFull(
        bookTitle, bookAuthor, currentChapterTitle, chunks[0].text, allChapterTitles, config, contextWindow,
      );
      totalRateLimitMs += firstRl;
      let accumulated = firstResult;

      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[analyze] Chapter "${currentChapterTitle}" chunk ${chunk.index + 1}/${chunk.total} (${chunk.text.length} chars)`);
        const { result: chunkResult, totalRateLimitMs: chunkRl } = await runMultiPassDelta(
          bookTitle, bookAuthor, currentChapterTitle, chunk.text, accumulated, config, contextWindow,
        );
        totalRateLimitMs += chunkRl;
        accumulated = chunkResult;
      }
      result = accumulated;
    }

    return NextResponse.json({ ...result, _model: modelName, _rateLimitWaitMs: totalRateLimitMs || undefined });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analyze] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
