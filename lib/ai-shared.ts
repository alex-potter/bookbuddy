/**
 * Shared AI prompt-building and response-parsing logic.
 * Pure TypeScript — works in both browser (mobile/APK) and Node.js (server route).
 */

import type { AnalysisResult } from '@/types';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a literary companion that helps readers keep track of characters in the book they are currently reading. Your most important rule is NEVER SPOILING anything beyond what appears in the text provided.

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

Your output must be valid JSON and nothing else.`;

export const SCHEMA = `{
  "characters": [
    {
      "name": "Full character name",
      "aliases": ["nickname", "title", "other names"],
      "importance": "main" | "secondary" | "minor",
      "status": "alive" | "dead" | "unknown" | "uncertain",
      "lastSeen": "Chapter title where they last appeared",
      "currentLocation": "Last known location, or 'Unknown'",
      "description": "1–2 sentence description of who they are, their role, and appearance/personality as established so far",
      "relationships": [
        { "character": "Other character's name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key things that have happened to or involving this character in the most recent chapters read"
    }
  ],
  "locations": [
    {
      "name": "Location name (must match a currentLocation value used above)",
      "description": "1–2 sentence description of this place — what kind of place it is, its significance, atmosphere, or notable features as established in the text"
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter, from the reader's perspective"
}`;

export const DELTA_SCHEMA = `{
  "updatedCharacters": [
    {
      "name": "Full character name",
      "aliases": ["nickname", "title", "other names"],
      "importance": "main" | "secondary" | "minor",
      "status": "alive" | "dead" | "unknown" | "uncertain",
      "lastSeen": "Chapter title where they last appeared",
      "currentLocation": "Last known location, or 'Unknown'",
      "description": "1–2 sentence description (carry forward from existing state if unchanged)",
      "relationships": [
        { "character": "Other character's name", "relationship": "How they relate" }
      ],
      "recentEvents": "Key things that happened in the NEW chapter only"
    }
  ],
  "updatedLocations": [
    {
      "name": "Location name",
      "description": "1–2 sentence description of this place as revealed so far"
    }
  ],
  "summary": "2–3 sentence summary of where the story stands as of the current chapter"
}`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const MAX_NEW_CHARS = 120_000;
const MAX_CHARS = 180_000;
const HEAD_CHARS = 50_000;

export function buildFullPrompt(bookTitle: string, bookAuthor: string, currentChapterTitle: string, text: string): string {
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

Analyze the text below and extract a COMPLETE character roster — every named character who appears, from major protagonists to characters who appear in a single scene. Do not skip anyone because they seem minor.

TEXT I HAVE READ:
${text}

Return ONLY a JSON object matching this exact schema (no markdown fences, no explanation):
${SCHEMA}`;
}

export function compactCharacterList(chars: AnalysisResult['characters']): string {
  return chars
    .map((c) => `- ${c.name} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`)
    .join('\n');
}

export function buildUpdatePrompt(
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
3. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in.
4. Do NOT include characters from the existing list who do not appear in the new chapter.
5. For any location that appears or is described in this chapter: include it in "updatedLocations" with a 1–2 sentence description. Only include locations with meaningful descriptions; omit vague or unnamed places.
6. Update the summary to reflect the story as of the current chapter.
7. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.

Return ONLY a JSON object with "updatedCharacters", "updatedLocations", and "summary" (no markdown fences, no explanation):
${DELTA_SCHEMA}`;
}

export function truncateForFullAnalysis(fullText: string): string {
  if (fullText.length <= MAX_CHARS) return fullText;
  const head = fullText.slice(0, HEAD_CHARS);
  const tail = fullText.slice(-(MAX_CHARS - HEAD_CHARS));
  return `${head}\n\n[... middle chapters omitted to fit context ...]\n\n${tail}`;
}

export function truncateForDelta(newText: string): string {
  return newText.length > MAX_NEW_CHARS ? newText.slice(-MAX_NEW_CHARS) : newText;
}

// ---------------------------------------------------------------------------
// Delta merge
// ---------------------------------------------------------------------------

export function mergeDelta(
  previous: AnalysisResult,
  delta: { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; summary?: string },
): AnalysisResult {
  const merged = previous.characters.map((c) => ({ ...c }));
  for (const updated of delta.updatedCharacters ?? []) {
    const idx = merged.findIndex((c) => c.name.toLowerCase() === updated.name.toLowerCase());
    if (idx >= 0) merged[idx] = { ...merged[idx], ...updated };
    else merged.push(updated);
  }
  const prevLocations = previous.locations ?? [];
  const mergedLocations = [...prevLocations];
  for (const updated of delta.updatedLocations ?? []) {
    const idx = mergedLocations.findIndex((l) => l.name.toLowerCase() === updated.name.toLowerCase());
    if (idx >= 0) mergedLocations[idx] = { ...mergedLocations[idx], ...updated };
    else mergedLocations.push(updated);
  }
  return {
    characters: merged,
    locations: mergedLocations.length > 0 ? mergedLocations : undefined,
    summary: delta.summary ?? previous.summary,
  };
}

// ---------------------------------------------------------------------------
// JSON recovery
// ---------------------------------------------------------------------------

export function extractObjectsFromArray(raw: string, fieldName: string): AnalysisResult['characters'] {
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
    if (depth !== 0) break;
    try { items.push(JSON.parse(raw.slice(i, j))); } catch { /* skip malformed */ }
    i = j;
  }
  return items;
}

export function recoverPartialJson(raw: string, previousResult?: AnalysisResult): AnalysisResult | null {
  try {
    const characters = extractObjectsFromArray(raw, 'characters');
    const updatedCharacters = extractObjectsFromArray(raw, 'updatedCharacters');
    const summaryMatch = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const summary = summaryMatch
      ? summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
      : previousResult?.summary ?? '';
    if (characters.length > 0) return { characters, summary };
    if (updatedCharacters.length > 0 && previousResult) {
      return mergeDelta(previousResult, { updatedCharacters, summary });
    }
    return null;
  } catch {
    return null;
  }
}
