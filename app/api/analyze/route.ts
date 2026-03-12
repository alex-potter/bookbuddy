import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import type { AnalysisResult } from '@/types';

// Undici agent with no headers/body timeout — our AbortController handles cancellation
const ollamaAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const anthropic = new Anthropic();

// Max chars of new chapter text to send in incremental mode
const MAX_NEW_CHARS = 120_000;
// Max chars for full analysis (no prior state)
const MAX_CHARS = 180_000;
const HEAD_CHARS = 50_000;

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

CHARACTER COMPLETENESS RULES:
- Include EVERY named character who appears in the text, no matter how briefly — protagonists, antagonists, and minor characters alike.
- A character mentioned once by name still gets an entry.
- Never filter, skip, or summarize away characters because they seem unimportant.
- NEVER group characters together (e.g. do NOT create entries like "The Hobbits", "The Fellowship", "The Guards"). Every individual must have their own separate entry under their own name.

DEDUPLICATION RULES (critical):
- A character must appear EXACTLY ONCE regardless of how many names or nicknames they are called by.
- If the same person is referred to by multiple names (e.g. "Matrim Cauthon" and "Mat"), create ONE entry using their fullest known name and list all shorter forms in "aliases".
- Never create separate entries for a full name and its nickname or shortened form.`;

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
      "aliases": ["nickname", "title", "other names"],
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
      "aliases": ["nickname", "title", "other names"],
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
      "arc": "Short narrative arc label (2–4 words max) grouping related locations into the same broad storyline thread. Use one of the arc names provided above whenever it fits. Aim for 3–5 arc labels total for the whole book.",
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
      "arc": "Use one of the arc names provided above. Only create a new label if no existing one applies — keep total distinct arcs to 5 or fewer.",
      "description": "1–2 sentence description of this place as revealed so far",
      "recentEvents": "1–2 sentences describing what happened at this location in this chapter. Omit if nothing notable occurred here.",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate" }
      ]
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter"
}`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildArcsFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  text: string,
  allChapterTitles?: string[],
): string {
  const tocBlock = allChapterTitles && allChapterTitles.length > 1
    ? `\nTABLE OF CONTENTS (${allChapterTitles.length} chapters total — use this to calibrate arc scope):\n${allChapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".
${tocBlock}
Identify the major narrative plot threads (arcs) present in the text below.

TEXT:
${text}

ARC RULES:
- Identify 3–7 major plot threads (fewer is better — combine closely related threads into one).
- Each arc should span multiple chapters and drive meaningful story action.
- Do not create an arc for every scene; only for threads that have clear ongoing stakes.
- "status": "active" = ongoing, "resolved" = concluded, "dormant" = paused/not mentioned recently.
- The table of contents above shows the full scope of the book — create arcs broad enough to last, not micro-arcs for individual scenes.

Return ONLY a JSON object (no markdown fences, no explanation):
${ARC_SCHEMA}`;
}

function buildArcsDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  previousArcs: AnalysisResult['arcs'],
  text: string,
): string {
  const arcCount = previousArcs?.length ?? 0;
  const arcLines = (previousArcs ?? [])
    .map((a) => `- ${a.name} [${a.status}]: ${a.summary}`)
    .join('\n');
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

EXISTING NARRATIVE ARCS (${arcCount} total — target is 3–6; use "retiredArcs" to drop any that have been absorbed or concluded):
${arcLines}

NEW CHAPTER TEXT:
${text}

Update the arcs based on this new chapter. ARC CONTINUITY RULES:
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
  arcs: AnalysisResult['arcs'],
  text: string,
): string {
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

NARRATIVE ARCS (for context — use arc names when describing character involvement):
${arcsSummary(arcs)}

TEXT:
${text}

Extract a COMPLETE character roster — every named character who appears, from major protagonists to characters who appear in a single scene. Do not skip anyone because they seem minor.

Return ONLY a JSON object (no markdown fences, no explanation):
${CHARACTER_SCHEMA}`;
}

function buildCharactersDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  arcs: AnalysisResult['arcs'],
  previousCharacters: AnalysisResult['characters'],
  text: string,
): string {
  const prevCount = previousCharacters.length;
  const charLines = previousCharacters
    .map((c) => `- ${c.name} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`)
    .join('\n');
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

NARRATIVE ARCS (for context):
${arcsSummary(arcs)}

EXISTING CHARACTERS (${prevCount} already tracked — DO NOT reproduce this list in your output):
${charLines}

NEW CHAPTER TEXT:
${text}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
1. For each character who APPEARS in the new chapter: include them in "updatedCharacters" with updated fields (status, currentLocation, recentEvents, lastSeen). Keep description/relationships from existing state unless the chapter changes them.
2. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in. NEVER group individuals — each person gets their own entry.
3. Do NOT include characters from the existing list who do not appear in the new chapter.
4. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.

Return ONLY a JSON object (no markdown fences, no explanation):
${CHARACTER_DELTA_SCHEMA}`;
}

function charactersSummary(chars: AnalysisResult['characters']): string {
  if (!chars?.length) return 'No characters yet.';
  return chars
    .map((c) => `- ${c.name} (loc: ${c.currentLocation ?? 'Unknown'}, status: ${c.status})`)
    .join('\n');
}

function buildLocationsFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  arcs: AnalysisResult['arcs'],
  characters: AnalysisResult['characters'],
  text: string,
  allChapterTitles?: string[],
): string {
  const tocBlock = allChapterTitles && allChapterTitles.length > 1
    ? `\nTABLE OF CONTENTS:\n${allChapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".
${tocBlock}
NARRATIVE ARCS (use these exact names for the "arc" field):
${arcsSummary(arcs)}

CHARACTERS AND THEIR CURRENT LOCATIONS (for cross-referencing):
${charactersSummary(characters)}

TEXT:
${text}

Extract all significant named locations from this text. Also write a story summary.

LOCATION RULES:
- Prefer broad canonical place names (city, castle, planet, ship) over sub-locations (rooms, corridors, hallways).
- If a place is inside or part of another location already listed, use the containing location's name instead.
- Include aliases — common shorter names readers might use for the same place.
- Use the arc names listed above for the "arc" field.

Return ONLY a JSON object (no markdown fences, no explanation):
${LOCATION_SCHEMA}`;
}

function buildLocationsDeltaPrompt(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  arcs: AnalysisResult['arcs'],
  characters: AnalysisResult['characters'],
  previousLocations: AnalysisResult['locations'],
  text: string,
): string {
  const existingLocs = (previousLocations ?? []).map((l) => l.name).filter(Boolean);
  const locLine = existingLocs.length > 0
    ? `\nEXISTING LOCATIONS (${existingLocs.length} already tracked — reuse the exact name if a new location is the same place, nearby, or contained within one of these): ${existingLocs.join(', ')}`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${chapterTitle}".

NARRATIVE ARCS (use these exact names for the "arc" field):
${arcsSummary(arcs)}

CHARACTERS AND THEIR CURRENT LOCATIONS (for cross-referencing):
${charactersSummary(characters)}
${locLine}

NEW CHAPTER TEXT:
${text}

For significant named places in this chapter: include them in "updatedLocations". CONSOLIDATION RULES:
- If the place is inside or part of an existing location (e.g. a room in a castle, a district of a city), use the existing location name instead.
- If the place is immediately adjacent to or commonly grouped with an existing location, use the existing location name.
- Only add a genuinely new entry if the place is distinct and would appear as a separate node on a map.
- Use arc names from above for the "arc" field.
Also write an updated story summary.

Return ONLY a JSON object (no markdown fences, no explanation):
${LOCATION_DELTA_SCHEMA}`;
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
  type Entry = { canonical: string; aliases: string[]; description: string; arc?: string; recentEvents?: string; relationships: LocRel[] };
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
      registerAliases(existingKey, loc.name, locAliases);
    } else {
      const key = normLoc(loc.name);
      const entry: Entry = { canonical: loc.name, aliases: locAliases, description: loc.description, arc: loc.arc, recentEvents: loc.recentEvents, relationships: loc.relationships ?? [] };
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

  return [...groups.values()].map(({ canonical, aliases, description, arc, recentEvents, relationships }) => ({
    name: canonical,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(arc ? { arc } : {}),
    description,
    ...(recentEvents ? { recentEvents } : {}),
    ...(relationships.length > 0 ? { relationships } : {}),
  }));
}

/** Merge characters that share a name/alias so nicknames don't create duplicate entries. */
function deduplicateCharacters(chars: AnalysisResult['characters']): AnalysisResult['characters'] {
  const norm = (s: string) => s.toLowerCase().trim();
  const result: AnalysisResult['characters'] = [];
  const nameIndex = new Map<string, number>();

  for (const char of chars) {
    const allNames = [char.name, ...(char.aliases ?? [])].map(norm).filter(Boolean);
    const existingIdx = allNames.reduce<number | undefined>(
      (found, n) => found ?? nameIndex.get(n),
      undefined,
    );

    if (existingIdx !== undefined) {
      const existing = result[existingIdx];
      const canonical = existing.name.length >= char.name.length ? existing.name : char.name;
      const aliasSet = new Set([
        ...(existing.aliases ?? []),
        ...(char.aliases ?? []),
        existing.name !== canonical ? existing.name : '',
        char.name !== canonical ? char.name : '',
      ].map(s => s.trim()).filter(Boolean));
      result[existingIdx] = { ...existing, ...char, name: canonical, aliases: [...aliasSet] };
      allNames.forEach(n => nameIndex.set(n, existingIdx));
    } else {
      const idx = result.length;
      result.push(char);
      allNames.forEach(n => nameIndex.set(n, idx));
    }
  }
  return result;
}

const MAX_ARCS = 8;

function mergeDelta(
  previous: AnalysisResult,
  delta: { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; updatedArcs?: AnalysisResult['arcs']; renamedArcs?: { from: string; to: string }[]; retiredArcs?: string[]; summary?: string },
): AnalysisResult {
  const merged = previous.characters.map((c) => ({ ...c }));
  const norm = (s: string) => s.toLowerCase().trim();
  for (const updated of delta.updatedCharacters ?? []) {
    if (!updated.name) continue;
    const updatedNames = new Set([updated.name, ...(updated.aliases ?? [])].map(norm));
    const idx = merged.findIndex((c) =>
      [c.name, ...(c.aliases ?? [])].some((n) => updatedNames.has(norm(n))),
    );
    if (idx >= 0) {
      const existing = merged[idx];
      const canonicalName = updated.name.length >= existing.name.length ? updated.name : existing.name;
      const allAliases = [...new Set([
        ...(existing.aliases ?? []),
        ...(updated.aliases ?? []),
        updated.name !== canonicalName ? updated.name : '',
        existing.name !== canonicalName ? existing.name : '',
      ].map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== canonicalName.toLowerCase()))];
      merged[idx] = { ...existing, ...updated, name: canonicalName, aliases: allAliases };
    } else {
      merged.push(updated);
    }
  }

  const prevLocations = previous.locations ?? [];
  const mergedLocations = [...prevLocations];
  for (const updated of delta.updatedLocations ?? []) {
    if (!updated.name) continue;
    const updatedNames = new Set([updated.name, ...(updated.aliases ?? [])].map((s) => s.toLowerCase()));
    const idx = mergedLocations.findIndex((l) =>
      [l.name, ...(l.aliases ?? [])].some((n) => updatedNames.has(n.toLowerCase())),
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
      mergedLocations[idx] = { ...existing, ...updated, name: canonicalName, aliases: allAliases.length > 0 ? allAliases : undefined };
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

// ─── LLM providers ───────────────────────────────────────────────────────────

async function callAnthropic(system: string, userPrompt: string, opts: { apiKey?: string; model?: string } = {}): Promise<string> {
  const client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : anthropic;
  const response = await client.messages.create({
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('No text response from Anthropic.');
  return block.text;
}

async function callLocal(system: string, userPrompt: string, opts: { baseUrl?: string; model?: string } = {}): Promise<string> {
  const baseUrl = opts.baseUrl ?? process.env.LOCAL_MODEL_URL ?? 'http://localhost:11434/v1';
  const model = opts.model ?? process.env.LOCAL_MODEL_NAME ?? 'llama3.1:8b';

  const res = await undiciFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    dispatcher: ollamaAgent,
    body: JSON.stringify({
      model,
      max_tokens: 32768,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    }),
  } as Parameters<typeof undiciFetch>[1]);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Local model error (${res.status}): ${err}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in local model response.');
  return text;
}

type CallOpts = { baseUrl?: string; model?: string } | { apiKey?: string; model?: string };

async function callLLM(system: string, userPrompt: string, useLocal: boolean, callOpts: CallOpts): Promise<string> {
  return useLocal
    ? callLocal(system, userPrompt, callOpts as { baseUrl?: string; model?: string })
    : callAnthropic(system, userPrompt, callOpts as { apiKey?: string; model?: string });
}

async function callAndParseJSON<T>(
  system: string,
  userPrompt: string,
  useLocal: boolean,
  callOpts: CallOpts,
  label: string,
): Promise<T | null> {
  async function attempt(): Promise<T | null> {
    const raw = await callLLM(system, userPrompt, useLocal, callOpts);
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      console.warn(`[analyze] ${label} JSON parse failed. Preview:`, cleaned.slice(-200));
      return null;
    }
  }

  let result = await attempt();
  if (!result) {
    console.warn(`[analyze] ${label}: retrying after parse failure…`);
    result = await attempt();
  }
  return result;
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
  useLocal: boolean,
  callOpts: CallOpts,
): Promise<AnalysisResult> {
  // Pass 1: Arcs
  console.log('[analyze] Pass 1: arcs');
  const arcsResult = await callAndParseJSON<{ arcs?: AnalysisResult['arcs'] }>(
    ARCS_SYSTEM,
    buildArcsFullPrompt(bookTitle, bookAuthor, chapterTitle, text, allChapterTitles),
    useLocal, callOpts, 'arcs-full',
  );
  const arcs = arcsResult?.arcs ?? [];
  console.log(`[analyze] Pass 1 done: ${arcs.length} arcs`);

  // Pass 2: Characters
  console.log('[analyze] Pass 2: characters');
  const charsResult = await callAndParseJSON<{ characters?: AnalysisResult['characters'] }>(
    CHARACTERS_SYSTEM,
    buildCharactersFullPrompt(bookTitle, bookAuthor, chapterTitle, arcs, text),
    useLocal, callOpts, 'characters-full',
  );
  const characters = charsResult?.characters ?? [];
  console.log(`[analyze] Pass 2 done: ${characters.length} characters`);

  // Pass 3: Locations + summary
  console.log('[analyze] Pass 3: locations');
  const locsResult = await callAndParseJSON<LocResult>(
    LOCATIONS_SYSTEM,
    buildLocationsFullPrompt(bookTitle, bookAuthor, chapterTitle, arcs, characters, text, allChapterTitles),
    useLocal, callOpts, 'locations-full',
  );
  const locations = locsResult?.locations ?? [];
  const summary = locsResult?.summary ?? '';
  console.log(`[analyze] Pass 3 done: ${locations.length} locations`);

  return { characters, locations: locations.length > 0 ? locations : undefined, arcs: arcs.length > 0 ? arcs : undefined, summary };
}

async function runMultiPassDelta(
  bookTitle: string,
  bookAuthor: string,
  chapterTitle: string,
  text: string,
  previousResult: AnalysisResult,
  useLocal: boolean,
  callOpts: CallOpts,
): Promise<AnalysisResult> {
  // Pass 1: Arcs
  console.log('[analyze] Pass 1: arcs (delta)');
  const arcsResult = await callAndParseJSON<ArcDeltaResult>(
    ARCS_SYSTEM,
    buildArcsDeltaPrompt(bookTitle, bookAuthor, chapterTitle, previousResult.arcs, text),
    useLocal, callOpts, 'arcs-delta',
  );
  // Apply arc renames/retires to get current arc state for use as context in passes 2+3
  const arcDelta = {
    updatedArcs: arcsResult?.updatedArcs,
    renamedArcs: arcsResult?.renamedArcs,
    retiredArcs: arcsResult?.retiredArcs,
  };
  const afterArcs = mergeDelta(previousResult, arcDelta);
  const currentArcs = afterArcs.arcs ?? [];
  console.log(`[analyze] Pass 1 done: ${arcDelta.updatedArcs?.length ?? 0} arc changes → ${currentArcs.length} arcs`);

  // Pass 2: Characters
  console.log('[analyze] Pass 2: characters (delta)');
  const charsResult = await callAndParseJSON<CharDeltaResult>(
    CHARACTERS_SYSTEM,
    buildCharactersDeltaPrompt(bookTitle, bookAuthor, chapterTitle, currentArcs, previousResult.characters, text),
    useLocal, callOpts, 'characters-delta',
  );
  const charDelta = { updatedCharacters: charsResult?.updatedCharacters };
  // Merge char delta into afterArcs state to get current character list for pass 3 context
  const afterChars = mergeDelta(afterArcs, charDelta);
  const currentCharacters = afterChars.characters;
  console.log(`[analyze] Pass 2 done: ${charDelta.updatedCharacters?.length ?? 0} char changes → ${currentCharacters.length} chars`);

  // Pass 3: Locations + summary
  console.log('[analyze] Pass 3: locations (delta)');
  const locsResult = await callAndParseJSON<LocDeltaResult>(
    LOCATIONS_SYSTEM,
    buildLocationsDeltaPrompt(bookTitle, bookAuthor, chapterTitle, currentArcs, currentCharacters, previousResult.locations, text),
    useLocal, callOpts, 'locations-delta',
  );
  const locDelta = { updatedLocations: locsResult?.updatedLocations, summary: locsResult?.summary };
  console.log(`[analyze] Pass 3 done: ${locDelta.updatedLocations?.length ?? 0} location changes`);

  // Final merge: combine all deltas
  const finalResult = mergeDelta(afterChars, locDelta);
  console.log(`[analyze] Delta complete: ${finalResult.characters.length} chars, ${finalResult.arcs?.length ?? 0} arcs, ${finalResult.locations?.length ?? 0} locs`);
  return finalResult;
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
      _provider?: 'anthropic' | 'ollama';
      _apiKey?: string;
      _ollamaUrl?: string;
      _model?: string;
    };
    const { chaptersRead, newChapters, allChapterTitles, currentChapterTitle, bookTitle, bookAuthor, previousResult,
      _provider, _apiKey, _ollamaUrl, _model } = body;

    const serverHasKey = !!process.env.ANTHROPIC_API_KEY;
    const serverUsesLocal = process.env.USE_LOCAL_MODEL === 'true';
    const serverConfigured = serverHasKey || serverUsesLocal;

    const useLocal = serverConfigured ? serverUsesLocal : (_provider !== 'anthropic');
    const callOpts: CallOpts = useLocal
      ? { baseUrl: process.env.LOCAL_MODEL_URL ?? _ollamaUrl, model: process.env.LOCAL_MODEL_NAME ?? _model }
      : { apiKey: process.env.ANTHROPIC_API_KEY ?? _apiKey, model: _model };

    if (!useLocal && !(callOpts as { apiKey?: string }).apiKey) {
      return NextResponse.json(
        { error: 'No Anthropic API key configured. Open ⚙ Settings to add your key.' },
        { status: 400 },
      );
    }

    const isDelta = !!(previousResult && newChapters?.length);
    const modelName = useLocal
      ? ((callOpts as { model?: string }).model ?? process.env.LOCAL_MODEL_NAME ?? 'qwen2.5:14b')
      : ((callOpts as { model?: string }).model ?? 'claude-haiku-4-5-20251001');

    let result: AnalysisResult;

    if (isDelta) {
      const newText = newChapters!
        .map((ch) => `=== ${ch.title} ===\n\n${ch.text}`)
        .join('\n\n---\n\n');
      const truncatedNew = newText.length > MAX_NEW_CHARS ? newText.slice(-MAX_NEW_CHARS) : newText;
      result = await runMultiPassDelta(bookTitle, bookAuthor, currentChapterTitle, truncatedNew, previousResult!, useLocal, callOpts);
    } else {
      if (!chaptersRead?.length) {
        return NextResponse.json({ error: 'No chapter text provided.' }, { status: 400 });
      }
      const fullText = chaptersRead
        .map((ch) => `=== ${ch.title} ===\n\n${ch.text}`)
        .join('\n\n---\n\n');
      const truncated = (() => {
        if (fullText.length <= MAX_CHARS) return fullText;
        const head = fullText.slice(0, HEAD_CHARS);
        const tail = fullText.slice(-(MAX_CHARS - HEAD_CHARS));
        return `${head}\n\n[... middle chapters omitted to fit context ...]\n\n${tail}`;
      })();
      result = await runMultiPassFull(bookTitle, bookAuthor, currentChapterTitle, truncated, allChapterTitles, useLocal, callOpts);
    }

    result = { ...result, characters: deduplicateCharacters(result.characters), locations: deduplicateLocations(result.locations) };
    return NextResponse.json({ ...result, _model: modelName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analyze] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
