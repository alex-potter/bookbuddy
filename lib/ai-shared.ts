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

CHARACTER EXTRACTION RULES:
- Include every named character who LITERALLY APPEARS BY NAME in the text provided — protagonists, antagonists, and minor characters alike.
- A character mentioned once by name still gets an entry.
- Never filter, skip, or summarize away characters because they seem unimportant.

ANTI-HALLUCINATION RULES (critical):
- ONLY include characters whose name or alias literally appears as text in the provided chapter.
- Do NOT invent or infer characters from context clues, summaries, or your knowledge of the book/series.
- Titles and epithets for the same person must be listed as aliases, not separate entries.

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
      "description": "1–2 sentence description of this place — what kind of place it is, its significance, atmosphere, or notable features as established in the text",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate — e.g. 'contains', 'part of', 'adjacent to', 'connected by road to', 'visible from', 'governs'" }
      ]
    }
  ],
  "arcs": [
    {
      "name": "Short name for this plot thread (e.g. 'Frodo's journey to Mordor')",
      "status": "active" | "resolved" | "dormant",
      "characters": ["character names involved in this arc"],
      "summary": "1–2 sentences on where this arc stands right now"
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
      "description": "1–2 sentence description of this place as revealed so far",
      "relationships": [
        { "location": "Another location name", "relationship": "How these places relate — e.g. 'contains', 'part of', 'adjacent to', 'connected by road to', 'visible from', 'governs'" }
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
  "summary": "2–3 sentence summary of where the story stands as of the current chapter"
}`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const MAX_NEW_CHARS = 120_000;
const MAX_CHARS = 180_000;
const HEAD_CHARS = 50_000;

export function buildFullPrompt(bookTitle: string, bookAuthor: string, currentChapterTitle: string, text: string, allChapterTitles?: string[]): string {
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

export function compactCharacterList(chars: AnalysisResult['characters']): string {
  return chars
    .map((c) => {
      const aliasStr = c.aliases?.length ? ` [aliases: ${c.aliases.join(', ')}]` : '';
      return `- ${c.name}${aliasStr} (${c.status}, last: ${c.lastSeen ?? '?'}, loc: ${c.currentLocation ?? '?'})`;
    })
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
  const arcList = (previousResult.arcs ?? [])
    .map((a) => `- ${a.name} [${a.status}]: ${a.summary}`)
    .join('\n');
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

EXISTING CHARACTERS (${prevCount} already tracked — DO NOT reproduce this list in your output):
${compactCharacterList(previousResult.characters)}
${arcList ? `\nEXISTING NARRATIVE ARCS (carry forward unchanged arcs; only include in "updatedArcs" if this chapter changes them):\n${arcList}\n` : ''}
NEW CHAPTER TEXT TO PROCESS:
${newChaptersText}

INSTRUCTIONS — RETURN ONLY CHANGES, NOT THE FULL LIST:
1. Read the new chapter text carefully.
2. For each character who APPEARS in the new chapter: include them in "updatedCharacters" with updated fields (status, currentLocation, recentEvents, lastSeen). Keep description/relationships from existing state unless the chapter changes them.
3. For any BRAND NEW named character introduced in this chapter: include them in "updatedCharacters" with all fields filled in.
4. Do NOT include characters from the existing list who do not appear in the new chapter.
5. When returning an existing character, use their EXACT NAME from the existing list. Do NOT use a shortened form or alternate spelling.
6. ONLY include characters whose name or alias literally appears in the new chapter text. Do NOT hallucinate characters.
7. For any location that appears or is described in this chapter: include it in "updatedLocations" with a 1–2 sentence description. Only include locations with meaningful descriptions; omit vague or unnamed places.
6. For narrative arcs: review existing arcs (listed below) and include in "updatedArcs" only those that progressed, changed status, or are new this chapter. Combine arcs that have merged. Keep the total arc count to 3–7 — prefer merging over multiplying.
7. Update the summary to reflect the story as of the current chapter.
8. Do NOT use any knowledge of this book beyond what is listed above and the new chapter text.

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
// Fuzzy name matching (mirrored from analyze/route.ts)
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function namesOverlap(namesA: string[], namesB: string[]): boolean {
  const normA = namesA.map((n) => n.toLowerCase().trim()).filter(Boolean);
  const normB = namesB.map((n) => n.toLowerCase().trim()).filter(Boolean);
  const setB = new Set(normB);
  // Exact match on any name/alias
  if (normA.some((n) => setB.has(n))) return true;
  // Prefix match only (not substring): "Mat" → "Matrim" is OK, "lan" → "Roland" is NOT
  for (const a of normA) {
    for (const b of normB) {
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
    }
  }
  // Token matching: require either 2+ shared tokens, or a single shared token ≥5 chars.
  // This prevents "Jon Snow" merging with "Jon Arryn" (shared "jon" is <5 and only 1 match).
  const tokensA = new Set(normA.flatMap((n) => n.split(/\s+/).filter((t) => t.length >= 3)));
  const tokensB = normB.flatMap((n) => n.split(/\s+/).filter((t) => t.length >= 3));
  const sharedTokens = tokensB.filter((t) => tokensA.has(t));
  if (sharedTokens.length >= 2) return true;
  if (sharedTokens.length === 1 && sharedTokens[0].length >= 5) return true;
  // Fuzzy match on full names
  for (const a of normA) {
    if (a.length < 5) continue;
    for (const b of normB) {
      if (b.length < 5 || Math.abs(a.length - b.length) > 2) continue;
      if (levenshtein(a, b) <= 2) return true;
    }
  }
  return false;
}

const IMPORTANCE_ORDER: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

// ---------------------------------------------------------------------------
// Delta merge
// ---------------------------------------------------------------------------

export function mergeDelta(
  previous: AnalysisResult,
  delta: { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; updatedArcs?: AnalysisResult['arcs']; summary?: string },
): AnalysisResult {
  const merged = previous.characters.map((c) => ({ ...c }));
  for (const updated of delta.updatedCharacters ?? []) {
    if (!updated.name) continue;
    const updatedNames = [updated.name, ...(updated.aliases ?? [])];
    // Primary name match first (strongest signal)
    let idx = merged.findIndex((c) => c.name.toLowerCase().trim() === updated.name.toLowerCase().trim());
    if (idx < 0) {
      // Alias-based matching with ambiguity check — if multiple characters match,
      // skip the merge to avoid combining distinct characters
      const candidates: number[] = [];
      for (let i = 0; i < merged.length; i++) {
        if (namesOverlap([merged[i].name, ...(merged[i].aliases ?? [])], updatedNames)) {
          candidates.push(i);
        }
      }
      idx = candidates.length === 1 ? candidates[0] : -1;
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
      // Intelligent field merging
      const relsSeen = new Map((existing.relationships ?? []).map((r) => [r.character.toLowerCase(), r]));
      for (const r of updated.relationships ?? []) {
        const key = r.character.toLowerCase();
        if (!relsSeen.has(key) || r.relationship.length > (relsSeen.get(key)!.relationship.length)) {
          relsSeen.set(key, r);
        }
      }
      const mergedDesc = (updated.description?.length ?? 0) > (existing.description?.length ?? 0)
        ? updated.description : existing.description;
      const mergedImportance = (IMPORTANCE_ORDER[updated.importance] ?? 0) > (IMPORTANCE_ORDER[existing.importance] ?? 0)
        ? updated.importance : existing.importance;
      const mergedRecent = updated.recentEvents || existing.recentEvents;
      merged[idx] = {
        ...existing, ...updated,
        name: canonicalName, aliases: allAliases,
        relationships: [...relsSeen.values()], description: mergedDesc,
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
    const updatedLocNames = [updated.name, ...(updated.aliases ?? [])];
    const idx = mergedLocations.findIndex((l) =>
      namesOverlap([l.name, ...(l.aliases ?? [])], updatedLocNames),
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
      const locRelsSeen = new Map((existing.relationships ?? []).map((r) => [r.location.toLowerCase(), r]));
      for (const r of updated.relationships ?? []) {
        const key = r.location.toLowerCase();
        if (!locRelsSeen.has(key) || r.relationship.length > (locRelsSeen.get(key)!.relationship.length)) {
          locRelsSeen.set(key, r);
        }
      }
      const mergedLocDesc = (updated.description?.length ?? 0) > (existing.description?.length ?? 0)
        ? updated.description : existing.description;
      mergedLocations[idx] = {
        ...existing, ...updated,
        name: canonicalName, aliases: allAliases.length > 0 ? allAliases : undefined,
        relationships: locRelsSeen.size > 0 ? [...locRelsSeen.values()] : undefined,
        description: mergedLocDesc,
      };
    } else {
      mergedLocations.push(updated);
    }
  }
  const prevArcs = previous.arcs ?? [];
  const mergedArcs = [...prevArcs];
  for (const updated of delta.updatedArcs ?? []) {
    const idx = mergedArcs.findIndex((a) => a.name.toLowerCase() === updated.name.toLowerCase());
    if (idx >= 0) mergedArcs[idx] = { ...mergedArcs[idx], ...updated };
    else mergedArcs.push(updated);
  }
  return {
    characters: merged,
    locations: mergedLocations.length > 0 ? mergedLocations : undefined,
    arcs: mergedArcs.length > 0 ? mergedArcs : undefined,
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
