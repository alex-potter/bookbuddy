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
      "currentLocation": "Proper place name (city/station/planet/region) — no parentheticals or activity descriptions. Use 'Unknown' if unclear.",
      "description": "1–2 sentence description of who they are, their role, and appearance/personality as established so far",
      "relationships": [
        { "character": "Other character's name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key things that have happened to or involving this character in the most recent chapters read"
    }
  ],
  "locations": [
    {
      "name": "Proper place name only — a city, station, planet, region, or named landmark (NOT a generic room, corridor, or activity description)",
      "arc": "Short narrative arc label grouping related locations into the same storyline thread (e.g. 'Shire', 'Quest', 'Gondor', 'Rohan'). Use the same label consistently across chapters for the same storyline. If a location belongs to multiple arcs choose the most prominent one.",
      "description": "1–2 sentence description of this place — what kind of place it is, its significance, atmosphere, or notable features as established in the text"
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter, from the reader's perspective"
}`;

function buildFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  currentChapterTitle: string,
  text: string,
): string {
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

Analyze the text below and extract a COMPLETE character roster — every named character who appears, from major protagonists to characters who appear in a single scene. Do not skip anyone because they seem minor.

TEXT I HAVE READ:
${text}

Return ONLY a JSON object matching this exact schema (no markdown fences, no explanation):
${SCHEMA}`;
}

// Compact representation of previous characters for the delta prompt
function compactCharacterList(chars: AnalysisResult['characters']): string {
  return chars
    .map((c) => `- ${c.name} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`)
    .join('\n');
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
      "currentLocation": "Proper place name (city/station/planet/region) — no parentheticals or activity descriptions. Use 'Unknown' if unclear.",
      "description": "1–2 sentence description (carry forward from existing state if unchanged)",
      "relationships": [
        { "character": "Other character's name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key things that happened in the NEW chapter only"
    }
  ],
  "updatedLocations": [
    {
      "name": "Proper place name only — a city, station, planet, region, or named landmark (NOT a generic room, corridor, or activity description)",
      "arc": "Short narrative arc label grouping related locations into the same storyline thread. Use the same label consistently for the same storyline across all chapters.",
      "description": "1–2 sentence description of this place as revealed so far"
    }
  ],
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
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

EXISTING CHARACTERS (${prevCount} already tracked — DO NOT reproduce this list in your output):
${compactCharacterList(previousResult.characters)}

NEW CHAPTER TEXT TO PROCESS:
${newChaptersText}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
1. Read the new chapter text carefully.
2. For each character who APPEARS in the new chapter: include them in "updatedCharacters" with updated fields (status, currentLocation, recentEvents, lastSeen). Keep description/relationships from existing state unless the chapter changes them.
3. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in. NEVER group individuals — each person gets their own entry.
4. Do NOT include characters from the existing list who do not appear in the new chapter.
5. For significant named places (cities, stations, planets, regions, named landmarks) that appear in this chapter: include them in "updatedLocations". Do NOT include generic rooms, corridors, vehicle interiors, or vague descriptions — only real proper-noun locations.
6. Update the summary to reflect the story as of the current chapter.
7. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.

Return ONLY a JSON object with "updatedCharacters", "updatedLocations", and "summary" (no markdown fences, no explanation):
${DELTA_SCHEMA}`;
}

function normLoc(name: string): string {
  return name.toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .split(',')[0].trim()
    .split(/\s+/).sort().join(' ');
}

/** Deduplicate locations, merging prefix-word subsets ("Eros" → "Eros Station"). */
function deduplicateLocations(locs: AnalysisResult['locations']): AnalysisResult['locations'] {
  if (!locs?.length) return locs;
  // Group by normalised key
  const groups = new Map<string, { canonical: string; description: string }>();
  for (const loc of locs) {
    const key = normLoc(loc.name);
    const existing = groups.get(key);
    if (existing) {
      // Keep longer description, prefer longer raw name
      if (loc.name.length > existing.canonical.length) existing.canonical = loc.name;
      if (loc.description.length > existing.description.length) existing.description = loc.description;
    } else {
      groups.set(key, { canonical: loc.name, description: loc.description });
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
        if (gs.description.length > gl.description.length) gl.description = gs.description;
        groups.delete(shorter);
        break;
      }
    }
  }
  return [...groups.values()].map(({ canonical, description }) => ({ name: canonical, description }));
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

// Merge a delta result into the previous full result
function mergeDelta(
  previous: AnalysisResult,
  delta: { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; summary?: string },
): AnalysisResult {
  const merged = previous.characters.map((c) => ({ ...c }));
  for (const updated of delta.updatedCharacters ?? []) {
    const idx = merged.findIndex((c) => c.name.toLowerCase() === updated.name.toLowerCase());
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...updated };
    } else {
      merged.push(updated);
    }
  }

  const prevLocations = previous.locations ?? [];
  const mergedLocations = [...prevLocations];
  for (const updated of delta.updatedLocations ?? []) {
    const idx = mergedLocations.findIndex((l) => l.name.toLowerCase() === updated.name.toLowerCase());
    if (idx >= 0) {
      mergedLocations[idx] = { ...mergedLocations[idx], ...updated };
    } else {
      mergedLocations.push(updated);
    }
  }

  return {
    characters: merged,
    locations: mergedLocations.length > 0 ? mergedLocations : undefined,
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
async function callAnthropic(system: string, userPrompt: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('No text response from Anthropic.');
  return block.text;
}

// --- Local / OpenAI-compatible provider (Ollama, LM Studio, etc.) ---
async function callLocal(system: string, userPrompt: string): Promise<string> {
  const baseUrl = process.env.LOCAL_MODEL_URL ?? 'http://localhost:11434/v1';
  const model = process.env.LOCAL_MODEL_NAME ?? 'llama3.1:8b';

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

export async function POST(req: NextRequest) {
  try {
    const { chaptersRead, newChapters, currentChapterTitle, bookTitle, bookAuthor, previousResult } =
      await req.json() as {
        chaptersRead?: Array<{ title: string; text: string }>;
        newChapters?: Array<{ title: string; text: string }>;
        currentChapterTitle: string;
        bookTitle: string;
        bookAuthor: string;
        previousResult?: AnalysisResult;
      };

    const useLocal = process.env.USE_LOCAL_MODEL === 'true';
    const isDelta = !!(previousResult && newChapters?.length);

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
      userPrompt = buildFullPrompt(bookTitle, bookAuthor, currentChapterTitle, truncated);
    }

    type ParseOutcome =
      | { ok: true; parsed: Record<string, unknown>; recovered: false }
      | { ok: true; parsed: AnalysisResult; recovered: true }
      | { ok: false };

    async function callAndParse(): Promise<ParseOutcome> {
      const raw = useLocal
        ? await callLocal(SYSTEM_PROMPT, userPrompt)
        : await callAnthropic(SYSTEM_PROMPT, userPrompt);

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
      return NextResponse.json({ ...finalResult, characters: deduplicateCharacters(finalResult.characters), locations: deduplicateLocations(finalResult.locations) });
    }

    const parsed = outcome.parsed;

    let result: AnalysisResult;
    if (isDelta) {
      // Delta response: merge updated/new characters into previous full state
      const delta = parsed as { updatedCharacters?: AnalysisResult['characters']; summary?: string };
      result = mergeDelta(previousResult!, delta);
      console.log(`[analyze] Delta merge: ${delta.updatedCharacters?.length ?? 0} changes → ${result.characters.length} total characters`);
    } else {
      result = parsed as unknown as AnalysisResult;
    }

    result = { ...result, characters: deduplicateCharacters(result.characters), locations: deduplicateLocations(result.locations) };
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analyze] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
