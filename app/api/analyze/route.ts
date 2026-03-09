import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult } from '@/types';

export const maxDuration = 120; // seconds
export const dynamic = 'force-dynamic';

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

Your output must be valid JSON and nothing else.`;

const SCHEMA = `{
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
  "summary": "2–3 sentence summary of where the story stands as of the current chapter, from the reader's perspective"
}`;

function buildFullPrompt(
  bookTitle: string,
  bookAuthor: string,
  currentChapterTitle: string,
  text: string,
): string {
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

Below is everything I have read so far. Please analyze it and return a JSON object tracking the characters and story state as I understand them RIGHT NOW — no more, no less.

TEXT I HAVE READ:
${text}

Return ONLY a JSON object matching this exact schema (no markdown fences, no explanation):
${SCHEMA}`;
}

function buildUpdatePrompt(
  bookTitle: string,
  bookAuthor: string,
  currentChapterTitle: string,
  previousResult: AnalysisResult,
  newChaptersText: string,
): string {
  return `I am reading "${bookTitle}" by ${bookAuthor}. I have just finished the chapter titled "${currentChapterTitle}".

Here is my existing character tracking state from when I last analyzed earlier chapters:
${JSON.stringify(previousResult, null, 2)}

Below are the NEW chapters I have read since then. Please UPDATE the character tracking state based only on what is revealed in these new chapters.

Rules for updating:
- Keep ALL existing characters — do not drop anyone even if they don't appear in the new chapters
- Update status, currentLocation, recentEvents, relationships only if new chapters reveal changes
- Add any brand new characters introduced in these chapters
- Update the summary to reflect the story as of the current chapter
- Do NOT use any knowledge of this book beyond what is in the text below

NEW CHAPTERS:
${newChaptersText}

Return ONLY the complete updated JSON object (same schema, no markdown fences, no explanation):
${SCHEMA}`;
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

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Local model error (${res.status}): ${err}`);
  }

  const data = await res.json();
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

    let userPrompt: string;

    if (previousResult && newChapters?.length) {
      // Incremental mode: only send new chapters + existing state
      const newText = newChapters
        .map((ch) => `=== ${ch.title} ===\n\n${ch.text}`)
        .join('\n\n---\n\n');
      const truncatedNew = newText.length > MAX_NEW_CHARS
        ? newText.slice(-MAX_NEW_CHARS)
        : newText;
      userPrompt = buildUpdatePrompt(bookTitle, bookAuthor, currentChapterTitle, previousResult, truncatedNew);
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

    const useLocal = process.env.USE_LOCAL_MODEL === 'true';
    const raw = useLocal
      ? await callLocal(SYSTEM_PROMPT, userPrompt)
      : await callAnthropic(SYSTEM_PROMPT, userPrompt);

    // Strip markdown code fences if the model wraps output in them
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return NextResponse.json(
        { error: 'Model returned malformed JSON. Try again.', raw },
        { status: 500 },
      );
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[analyze] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
