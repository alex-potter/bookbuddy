import type { AnalysisResult, Snapshot } from '@/types';

/**
 * Builds the system prompt for the book chat assistant.
 * Uses snapshot summaries (not raw chapter text) to stay within token limits
 * while giving the AI a rich, spoiler-safe narrative context.
 */
export function buildChatSystemPrompt(
  bookTitle: string,
  bookAuthor: string,
  lastAnalyzedIndex: number,
  currentChapterTitle: string,
  totalChapters: number,
  result: AnalysisResult,
  snapshots: Snapshot[],
  chapterTitles: string[],
): string {
  const chaptersRead = lastAnalyzedIndex + 1;

  // Chronological narrative from per-chapter summaries
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  const narrative = sorted
    .filter((s) => s.result.summary)
    .map((s) => {
      const title = chapterTitles[s.index] ?? `Chapter ${s.index + 1}`;
      return `[After "${title}"]: ${s.result.summary}`;
    })
    .join('\n\n');

  // Character digest — include all if small cast, otherwise skip minors
  const skipMinors = result.characters.length > 25;
  const chars = result.characters
    .filter((c) => !skipMinors || c.importance !== 'minor')
    .map((c) => {
      const parts: string[] = [`${c.name} (${c.status})`];
      if (c.currentLocation && c.currentLocation !== 'Unknown') parts.push(`at ${c.currentLocation}`);
      if (c.recentEvents) parts.push(`— ${c.recentEvents}`);
      else if (c.description) parts.push(`— ${c.description.split('.')[0]}`);
      return `• ${parts.join(', ')}`;
    })
    .join('\n');

  const locs = (result.locations ?? [])
    .map((l) => `• ${l.name}: ${l.description}`)
    .join('\n');

  return `You are a spoiler-free reading companion for "${bookTitle}" by ${bookAuthor}.

The reader has read ${chaptersRead} of ${totalChapters} chapters, through "${currentChapterTitle}".

CRITICAL ANTI-SPOILER RULES — follow without exception:
1. Only discuss events from chapters 1–${chaptersRead}. Never reveal or hint at what happens after.
2. If you recognise this book or series, IGNORE all knowledge beyond what is shown in the context below.
3. If asked about something that happens after chapter ${chaptersRead}, say "That hasn't happened in what you've read yet" — no further detail.
4. If uncertain whether something is a spoiler, err on the side of caution.

STORY CONTEXT — what the reader has seen:
${narrative || result.summary || '(No chapter summaries yet.)'}

CHARACTERS right now:
${chars || '(No characters tracked yet.)'}
${locs ? `\nLOCATIONS:\n${locs}` : ''}

Answer conversationally. Help the reader understand and enjoy what they have already read.`.trim();
}

/**
 * Builds a compact system prompt for on-device (local) models.
 * Keeps total prompt under ~1500 tokens by trimming characters,
 * limiting narrative history, and using shorter instructions.
 */
export function buildCompactChatSystemPrompt(
  bookTitle: string,
  bookAuthor: string,
  lastAnalyzedIndex: number,
  currentChapterTitle: string,
  totalChapters: number,
  result: AnalysisResult,
  snapshots: Snapshot[],
  chapterTitles: string[],
): string {
  const chaptersRead = lastAnalyzedIndex + 1;

  // Overall summary + recent chapter narrative (last 8 chapters max)
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  const recentSnapshots = sorted.filter((s) => s.result.summary).slice(-8);
  const chapterNarrative = recentSnapshots
    .map((s) => {
      const title = chapterTitles[s.index] ?? `Chapter ${s.index + 1}`;
      return `[${title}]: ${s.result.summary}`;
    })
    .join('\n');

  const narrativeParts: string[] = [];
  if (result.summary) narrativeParts.push(`OVERALL: ${result.summary}`);
  if (chapterNarrative) narrativeParts.push(chapterNarrative);
  const narrative = narrativeParts.join('\n\n') || '(No summaries yet.)';

  // Main and secondary characters only, minimal info
  const chars = result.characters
    .filter((c) => c.importance !== 'minor')
    .map((c) => {
      const loc = c.currentLocation && c.currentLocation !== 'Unknown' ? ` at ${c.currentLocation}` : '';
      return `• ${c.name} (${c.status}${loc})`;
    })
    .join('\n');

  // Top 10 locations only
  const locs = (result.locations ?? [])
    .slice(0, 10)
    .map((l) => `• ${l.name}: ${l.description.split('.')[0]}`)
    .join('\n');

  return `You are a spoiler-free reading companion for "${bookTitle}" by ${bookAuthor}.
Reader has read ${chaptersRead}/${totalChapters} chapters, through "${currentChapterTitle}".

RULES:
- Only discuss chapters 1–${chaptersRead}. Never reveal anything after.
- If you recognise this book, ignore outside knowledge.
- If unsure whether something is a spoiler, don't say it.

RECENT STORY:
${narrative}

CHARACTERS:
${chars || '(None tracked.)'}
${locs ? `\nLOCATIONS:\n${locs}` : ''}

Answer conversationally about what the reader has already read.`.trim();
}
