import { NextRequest, NextResponse } from 'next/server';
import type { AnalysisResult } from '@/types';
import { reconcileResult, type CallAndParseFn } from '@/lib/reconcile';
import { callLLM, resolveConfig } from '@/lib/llm';
import { getContextWindow, resolveMaxOutputTokens } from '@/lib/context-window';

// ─── JSON parsing helpers ────────────────────────────────────────────────────

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
    if (depth !== 0) break;
    try { items.push(JSON.parse(raw.slice(i, j))); } catch { /* skip malformed */ }
    i = j;
  }
  return items;
}

function recoverPartialResponse(raw: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const field of ['mergeGroups', 'splits']) {
    const items = extractJsonArray(raw, field);
    if (items.length > 0) result[field] = items;
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function callAndParseJSON<T>(
  system: string, userPrompt: string, config: ReturnType<typeof resolveConfig>, label: string,
  contextWindow: number | undefined,
): Promise<T | null> {
  const maxTokens = resolveMaxOutputTokens({
    contextWindow,
    floor: 16384,
    inputChars: userPrompt.length + (system?.length ?? 0),
    ceilingFraction: 0.5,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text: raw } = await callLLM({ ...config, system, userPrompt, maxTokens, jsonMode: true });
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const recovered = recoverPartialResponse(cleaned);
      if (recovered && Object.keys(recovered).length > 0) {
        console.log(`[reconcile] ${label}: recovered partial JSON`);
        return recovered as T;
      }
      if (attempt === 0) console.warn(`[reconcile] ${label}: parse failed, retrying…`);
      else console.warn(`[reconcile] ${label}: all attempts failed.`);
    }
  }
  return null;
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      result: AnalysisResult;
      bookTitle: string;
      bookAuthor: string;
      chapterExcerpts?: string;
      _provider?: string;
      _apiKey?: string;
      _ollamaUrl?: string;
      _model?: string;
      _geminiKey?: string;
      _openaiCompatibleUrl?: string;
      _openaiCompatibleKey?: string;
      _ollamaContextLength?: number;
    };
    const { result, bookTitle, bookAuthor, chapterExcerpts } = body;

    if (!result?.characters?.length) {
      return NextResponse.json({ error: 'No characters to reconcile.' }, { status: 400 });
    }

    const config = resolveConfig(body);
    if (body._ollamaContextLength && config.provider === 'ollama') {
      (config as { contextLengthOverride?: number }).contextLengthOverride = body._ollamaContextLength;
    }
    const { contextWindow } = await getContextWindow(config);
    const callAndParse: CallAndParseFn = <T>(system: string, userPrompt: string, label: string) =>
      callAndParseJSON<T>(system, userPrompt, config, label, contextWindow);

    const reconciled = await reconcileResult(result, bookTitle, bookAuthor, chapterExcerpts, callAndParse);
    return NextResponse.json(reconciled);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[reconcile] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
