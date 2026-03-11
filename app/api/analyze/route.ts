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

const SYSTEM_PROMPT = `You are a literary companion that helps readers keep track of characters in the book they are currently reading. Your most important rule is NEVER SPOILING anything beyond what appears in the text provided.

STRICT ANTI-SPOILER RULES (follow these without exception):
1. Base ALL information SOLELY on the text excerpt provided — nothing else.
2. If you recognise this book or series, IGNORE that knowledge entirely. Pretend you have never seen it before.
3. Only report facts that are explicitly stated or clearly implied by the text given.
4. If a character's fate, location, or status is uncertain based on the text, say so — do NOT infer from broader knowledge.
5. Do NOT hint at, foreshadow, or allude to future events in any way.
6. If a character has not appeared yet in the provided text, do NOT include them.

CHARACTER COMPLETENESS RULES:
- Include EVERY named character who appears in the text, no matter how briefly — protagonists, antagonists, and minor characters alike.
- A character mentioned once by name still gets an entry.
- Never filter, skip, or summarize away characters because they seem unimportant.
- NEVER group characters together (e.g. do NOT create entries like "The Hobbits", "The Fellowship", "The Guards"). Every individual must have their own separate entry under their own name.

DEDUPLICATION RULES (critical):
- A character must appear EXACTLY ONCE regardless of how many names or nicknames they are called by.
- If the same person is referred to by multiple names (e.g. "Matrim Cauthon" and "Mat"), create ONE entry using their fullest known name and list all shorter forms in "aliases".
- Never create separate entries for a full name and its nickname or shortened form.

Your output must be valid JSON and nothing else.`;

const SCHEMA = `{
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
  ],
  "locations": [
    {
      "name": "Broad canonical place name — city, castle, region, planet, ship (NOT a generic room, corridor, or sub-location). Prefer the containing location over sub-locations.",
      "aliases": ["shorter or alternate names readers use for this place — e.g. 'Ceres' for 'Ceres Station', 'the Pits' for 'Hellas Basin'"],
      "arc": "Short narrative arc label (2–4 words max) grouping related locations into the same broad storyline thread. Aim for 3–5 arc labels total for the whole book — broad strokes like 'The Journey', 'The War', 'The Shire', not a new label per chapter. If a location fits an existing arc, use that exact label.",
      "description": "1–2 sentence description of this place — what kind of place it is, its significance, atmosphere, or notable features as established in the text",
      "recentEvents": "1–2 sentences describing what happened at this location in the current chapter — key events, arrivals, departures, or confrontations. Omit if nothing notable occurred here.",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate — e.g. 'contains', 'part of', 'adjacent to', 'connected by road to', 'visible from', 'governs', 'supplies'" }
      ]
    }
  ],
  "arcs": [
    {
      "name": "Short name for this plot thread (e.g. 'Frodo\\'s journey to Mordor')",
      "status": "active" | "resolved" | "dormant",
      "characters": ["character names involved in this arc"],
      "summary": "1–2 sentences on where this arc stands right now"
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter, from the reader's perspective"
}`;

function buildFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  currentChapterTitle: string,
  text: string,
  allChapterTitles?: string[],
): string {
  const tocBlock = allChapterTitles && allChapterTitles.length > 1
    ? `\nTABLE OF CONTENTS (${allChapterTitles.length} chapters total — use this to calibrate arc scope):\n${allChapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".
${tocBlock}
Analyze the text below and extract a COMPLETE character roster — every named character who appears, from major protagonists to characters who appear in a single scene. Do not skip anyone because they seem minor.

TEXT I HAVE READ:
${text}

ARC RULES:
- Identify 3–7 major plot threads (fewer is better — combine closely related threads into one).
- Each arc should span multiple chapters and drive meaningful story action.
- Do not create an arc for every scene; only for threads that have clear ongoing stakes.
- "status": "active" = ongoing, "resolved" = concluded, "dormant" = paused/not mentioned recently.
- The table of contents above shows the full scope of the book — create arcs broad enough to last, not micro-arcs for individual scenes.

Return ONLY a JSON object matching this exact schema (no markdown fences, no explanation):
${SCHEMA}`;
}

// Compact representation of previous characters for the delta prompt
function compactCharacterList(chars: AnalysisResult['characters']): string {
  return chars
    .map((c) => `- ${c.name} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`)
    .join('\n');
}

// Collect distinct arc labels already in use
function existingArcLabels(locs: AnalysisResult['locations']): string[] {
  const seen = new Set<string>();
  for (const l of locs ?? []) if (l.arc?.trim()) seen.add(l.arc.trim());
  return [...seen];
}

// Collect existing location names for consolidation hints
function existingLocationNames(locs: AnalysisResult['locations']): string[] {
  return (locs ?? []).map((l) => l.name).filter(Boolean);
}

// Delta schema — only new/changed characters and locations
const DELTA_SCHEMA = `{
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
  ],
  "updatedLocations": [
    {
      "name": "Broad canonical place name — city, castle, region, planet, ship. Prefer the name of the containing location over sub-locations (use 'Minas Tirith' not 'the great hall of Minas Tirith'). Use an EXISTING LOCATION NAME if the place is the same, nearby, or contained within it.",
      "aliases": ["shorter or alternate names readers use for this place — only include if genuinely used in the text"],
      "arc": "Use one of the EXISTING ARC LABELS listed above whenever it fits. Only create a new label if no existing one applies — and keep the total number of distinct arcs to 5 or fewer for the whole book.",
      "description": "1–2 sentence description of this place as revealed so far",
      "recentEvents": "1–2 sentences describing what happened at this location in this chapter — key events, arrivals, departures, or confrontations. Omit if nothing notable occurred here.",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate — e.g. 'contains', 'part of', 'adjacent to', 'connected by road to', 'visible from', 'governs', 'supplies'" }
      ]
    }
  ],
  "updatedArcs": [
    {
      "name": "Arc name (must exactly match an existing arc name, or be new)",
      "status": "active" | "resolved" | "dormant",
      "characters": ["character names involved"],
      "summary": "1–2 sentences on where this arc stands after this chapter"
    }
  ],
  "retiredArcs": ["exact name of any arc being merged into another or permanently dropped"],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter"
}`;

function buildUpdatePrompt(
  bookTitle: string,
  bookAuthor: string,
  currentChapterTitle: string,
  previousResult: AnalysisResult,
  newChaptersText: string,
): string {
  const prevCount = previousResult.characters.length;
  const locationArcLabels = existingArcLabels(previousResult.locations);
  const locs = existingLocationNames(previousResult.locations);
  const arcLine = locationArcLabels.length > 0
    ? `\nEXISTING ARC LABELS (reuse these exactly — do not invent new ones unless none fit): ${locationArcLabels.join(', ')}`
    : '';
  const locLine = locs.length > 0
    ? `\nEXISTING LOCATIONS (${locs.length} already tracked — reuse the exact name if a new location is the same place, nearby, or contained within one of these): ${locs.join(', ')}`
    : '';
  const narrativeArcs = previousResult.arcs ?? [];
  const arcCount = narrativeArcs.length;
  const narrativeArcLine = narrativeArcs.length > 0
    ? `\nEXISTING NARRATIVE ARCS (${arcCount} total — target is 3–6; use "retiredArcs" to drop any that have been absorbed or concluded):\n${narrativeArcs.map((a) => `- ${a.name} [${a.status}]: ${a.summary}`).join('\n')}`
    : '';
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

EXISTING CHARACTERS (${prevCount} already tracked — DO NOT reproduce this list in your output):
${compactCharacterList(previousResult.characters)}${arcLine}${locLine}${narrativeArcLine}

NEW CHAPTER TEXT TO PROCESS:
${newChaptersText}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
1. Read the new chapter text carefully.
2. For each character who APPEARS in the new chapter: include them in "updatedCharacters" with updated fields (status, currentLocation, recentEvents, lastSeen). Keep description/relationships from existing state unless the chapter changes them.
3. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in. NEVER group individuals — each person gets their own entry.
4. Do NOT include characters from the existing list who do not appear in the new chapter.
5. For significant named places in this chapter: include them in "updatedLocations". CONSOLIDATION RULES — prefer fewer, broader locations: (a) if the place is inside or part of an existing location (e.g. a room in a castle, a district of a city), use the existing location name instead; (b) if the place is immediately adjacent to or commonly grouped with an existing location, use the existing location name; (c) only add a genuinely new entry if the place is distinct and would appear as a separate node on a map.
6. For narrative arcs: include in "updatedArcs" only arcs that progressed, changed status, or are new this chapter. If two arcs have merged into one storyline, add the surviving arc to "updatedArcs" and add the absorbed arc's name to "retiredArcs". If the total arc count would exceed 6, you MUST retire at least one — prefer merging related arcs over keeping them separate. Use "retiredArcs" to list any arc names being dropped.
7. Update the summary to reflect the story as of the current chapter.
8. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.

Return ONLY a JSON object with "updatedCharacters", "updatedLocations", "updatedArcs", "retiredArcs", and "summary" (no markdown fences, no explanation):
${DELTA_SCHEMA}`;
}

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

  // Group by normalised key; also maintain an alias lookup map
  const groups = new Map<string, Entry>();
  // aliasLookup: normalised alias → group key
  const aliasLookup = new Map<string, string>();

  function findGroupKey(name: string, aliases: string[]): string | undefined {
    const nk = normLoc(name);
    if (groups.has(nk)) return nk;
    if (aliasLookup.has(nk)) return aliasLookup.get(nk);
    for (const a of aliases) {
      const nа = normLoc(a);
      if (groups.has(nа)) return nа;
      if (aliasLookup.has(nа)) return aliasLookup.get(nа);
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
  // nameIndex maps every known normalised name/alias → index into result[]
  const nameIndex = new Map<string, number>();

  for (const char of chars) {
    const allNames = [char.name, ...(char.aliases ?? [])].map(norm).filter(Boolean);
    const existingIdx = allNames.reduce<number | undefined>(
      (found, n) => found ?? nameIndex.get(n),
      undefined,
    );

    if (existingIdx !== undefined) {
      // Merge into existing entry: keep longer name as canonical, union aliases
      const existing = result[existingIdx];
      const canonical = existing.name.length >= char.name.length ? existing.name : char.name;
      const aliasSet = new Set([
        ...(existing.aliases ?? []),
        ...(char.aliases ?? []),
        existing.name !== canonical ? existing.name : '',
        char.name !== canonical ? char.name : '',
      ].map(s => s.trim()).filter(Boolean));
      result[existingIdx] = { ...existing, ...char, name: canonical, aliases: [...aliasSet] };
      // Register any new names
      allNames.forEach(n => nameIndex.set(n, existingIdx));
    } else {
      const idx = result.length;
      result.push(char);
      allNames.forEach(n => nameIndex.set(n, idx));
    }
  }
  return result;
}

const MAX_ARCS = 8; // hard cap — prune oldest dormant/resolved if exceeded

// Merge a delta result into the previous full result
function mergeDelta(
  previous: AnalysisResult,
  delta: { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; updatedArcs?: AnalysisResult['arcs']; retiredArcs?: string[]; summary?: string },
): AnalysisResult {
  const merged = previous.characters.map((c) => ({ ...c }));
  const norm = (s: string) => s.toLowerCase().trim();
  for (const updated of delta.updatedCharacters ?? []) {
    if (!updated.name) continue;
    // Match by name OR any alias in either direction (handles renames like Strider→Aragorn)
    const updatedNames = new Set([updated.name, ...(updated.aliases ?? [])].map(norm));
    const idx = merged.findIndex((c) =>
      [c.name, ...(c.aliases ?? [])].some((n) => updatedNames.has(norm(n))),
    );
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...updated };
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
      const mergedAliases = [...new Set([...(existing.aliases ?? []), ...(updated.aliases ?? [])].filter((a) => a.toLowerCase() !== updated.name.toLowerCase() && a.toLowerCase() !== existing.name.toLowerCase()))];
      mergedLocations[idx] = { ...existing, ...updated, aliases: mergedAliases.length > 0 ? mergedAliases : undefined };
    } else {
      mergedLocations.push(updated);
    }
  }

  const retired = new Set((delta.retiredArcs ?? []).map((n) => n.toLowerCase()));
  const prevArcs = (previous.arcs ?? []).filter((a) => !retired.has(a.name.toLowerCase()));
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
  // Hard cap: if still over limit, prune resolved then dormant (oldest first)
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

/** Extract complete JSON objects from an array field that may be truncated. */
function extractObjectsFromArray(raw: string, fieldName: string): AnalysisResult['characters'] {
  const key = `"${fieldName}"`;
  const keyPos = raw.indexOf(key);
  if (keyPos === -1) return [];
  const bracketStart = raw.indexOf('[', keyPos);
  if (bracketStart === -1) return [];

  const items: AnalysisResult['characters'] = [];
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
    if (depth !== 0) break; // truncated — stop
    try { items.push(JSON.parse(raw.slice(i, j))); } catch { /* skip malformed */ }
    i = j;
  }
  return items;
}

// Attempt to recover partial/truncated JSON by extracting complete character objects
function recoverPartialJson(raw: string, previousResult?: AnalysisResult): AnalysisResult | null {
  try {
    // Try a full JSON.parse on the outermost {...} slice first
    const braceStart = raw.indexOf('{');
    const braceEnd = raw.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      try {
        const candidate = raw.slice(braceStart, braceEnd + 1);
        const p = JSON.parse(candidate) as Record<string, unknown>;
        if (p.characters || p.updatedCharacters !== undefined) return p as unknown as AnalysisResult;
      } catch { /* fall through to object-by-object extraction */ }
    }

    // Try full format first ("characters"), then delta format ("updatedCharacters")
    const characters = extractObjectsFromArray(raw, 'characters');
    const updatedCharacters = extractObjectsFromArray(raw, 'updatedCharacters');

    const summaryMatch = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const summary = summaryMatch
      ? summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
      : previousResult?.summary ?? '';

    if (characters.length > 0) {
      return { characters, summary };
    }
    if (previousResult) {
      // Even an empty updatedCharacters is valid (no changes this chapter)
      console.warn('[analyze] Recovered delta from truncated JSON —', updatedCharacters.length, 'updates');
      return mergeDelta(previousResult, { updatedCharacters, summary });
    }
    return null;
  } catch {
    return null;
  }
}

// --- Anthropic provider ---
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

// --- Local / OpenAI-compatible provider (Ollama, LM Studio, etc.) ---
async function callLocal(system: string, userPrompt: string, opts: { baseUrl?: string; model?: string } = {}): Promise<string> {
  const baseUrl = opts.baseUrl ?? process.env.LOCAL_MODEL_URL ?? 'http://localhost:11434/v1';
  const model = opts.model ?? process.env.LOCAL_MODEL_NAME ?? 'llama3.1:8b';

  // Use undici fetch with a custom agent — disables the default 300s headersTimeout
  // that fires independently of AbortController for slow local models.
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
      // Client-provided AI settings — used when server has no env config
      _provider?: 'anthropic' | 'ollama';
      _apiKey?: string;
      _ollamaUrl?: string;
      _model?: string;
    };
    const { chaptersRead, newChapters, allChapterTitles, currentChapterTitle, bookTitle, bookAuthor, previousResult,
      _provider, _apiKey, _ollamaUrl, _model } = body;

    // Server env vars take priority; fall back to client-provided settings
    const serverHasKey = !!process.env.ANTHROPIC_API_KEY;
    const serverUsesLocal = process.env.USE_LOCAL_MODEL === 'true';
    const serverConfigured = serverHasKey || serverUsesLocal;

    const useLocal = serverConfigured ? serverUsesLocal : (_provider !== 'anthropic');
    const callOpts = useLocal
      ? { baseUrl: process.env.LOCAL_MODEL_URL ?? _ollamaUrl, model: process.env.LOCAL_MODEL_NAME ?? _model }
      : { apiKey: process.env.ANTHROPIC_API_KEY ?? _apiKey, model: _model };

    if (!useLocal && !callOpts.apiKey) {
      return NextResponse.json(
        { error: 'No Anthropic API key configured. Open ⚙ Settings to add your key.' },
        { status: 400 },
      );
    }

    const isDelta = !!(previousResult && newChapters?.length);
    const modelName = useLocal
      ? (callOpts.model ?? process.env.LOCAL_MODEL_NAME ?? 'qwen2.5:14b')
      : (callOpts.model ?? 'claude-haiku-4-5-20251001');

    let userPrompt: string;

    if (isDelta) {
      // Delta mode: ask only for new/changed characters, merge server-side
      const newText = newChapters!
        .map((ch) => `=== ${ch.title} ===\n\n${ch.text}`)
        .join('\n\n---\n\n');
      const truncatedNew = newText.length > MAX_NEW_CHARS
        ? newText.slice(-MAX_NEW_CHARS)
        : newText;
      userPrompt = buildUpdatePrompt(bookTitle, bookAuthor, currentChapterTitle, previousResult!, truncatedNew);
    } else {
      // Full analysis mode
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
      userPrompt = buildFullPrompt(bookTitle, bookAuthor, currentChapterTitle, truncated, allChapterTitles);
    }

    type ParseOutcome =
      | { ok: true; parsed: Record<string, unknown>; recovered: false }
      | { ok: true; parsed: AnalysisResult; recovered: true }
      | { ok: false };

    async function callAndParse(): Promise<ParseOutcome> {
      const raw = useLocal
        ? await callLocal(SYSTEM_PROMPT, userPrompt, callOpts)
        : await callAnthropic(SYSTEM_PROMPT, userPrompt, callOpts);

      let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);

      try {
        return { ok: true, parsed: JSON.parse(cleaned) as Record<string, unknown>, recovered: false };
      } catch {
        const recovered = recoverPartialJson(cleaned, previousResult);
        if (recovered) {
          console.warn('[analyze] Recovered from truncated JSON — kept', recovered.characters.length, 'characters');
          return { ok: true, parsed: recovered, recovered: true };
        }
        console.warn('[analyze] Unrecoverable JSON. Raw length:', cleaned.length, 'Preview:', cleaned.slice(-200));
        return { ok: false };
      }
    }

    let outcome = await callAndParse();
    if (!outcome.ok) {
      console.warn('[analyze] Retrying after unrecoverable JSON…');
      outcome = await callAndParse();
    }
    if (!outcome.ok) {
      return NextResponse.json({ error: 'Model returned malformed JSON. Try again.' }, { status: 500 });
    }

    // Recovered path: AnalysisResult already merged by recoverPartialJson
    if (outcome.recovered) {
      const r = outcome.parsed;
      const finalResult = isDelta
        ? mergeDelta(previousResult!, { updatedCharacters: r.characters, summary: r.summary })
        : r;
      return NextResponse.json({ ...finalResult, characters: deduplicateCharacters(finalResult.characters), locations: deduplicateLocations(finalResult.locations), _model: modelName });
    }

    const parsed = outcome.parsed;

    let result: AnalysisResult;
    if (isDelta) {
      // Delta response: merge updated/new characters into previous full state
      const delta = parsed as { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; updatedArcs?: AnalysisResult['arcs']; retiredArcs?: string[]; summary?: string };
      result = mergeDelta(previousResult!, delta);
      console.log(`[analyze] Delta merge: ${delta.updatedCharacters?.length ?? 0} char changes, ${delta.updatedArcs?.length ?? 0} arc changes → ${result.characters.length} chars, ${result.arcs?.length ?? 0} arcs`);
    } else {
      result = parsed as unknown as AnalysisResult;
    }

    result = { ...result, characters: deduplicateCharacters(result.characters), locations: deduplicateLocations(result.locations) };
    return NextResponse.json({ ...result, _model: modelName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analyze] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
