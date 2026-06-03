import { NextRequest, NextResponse } from 'next/server';
import type { AnalysisResult } from '@/types';
import {
  CHAR_RECONCILE_SYSTEM, buildCharReconcilePrompt,
  LOC_RECONCILE_SYSTEM, buildLocReconcilePrompt,
  ARC_RECONCILE_SYSTEM, buildArcReconcilePrompt,
  indexProposalsToNamed,
  type ReconcileResult, type CharSplitEntry, type LocSplitEntry, type ArcSplitEntry,
  type ReconcileProposals,
} from '@/lib/reconcile';
import { callLLM, resolveConfig } from '@/lib/llm';
import { getContextWindow, resolveMaxOutputTokens } from '@/lib/context-window';

// ─── JSON parsing helpers ────────────────────────────────────────────────────

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
        console.log(`[reconcile-propose] ${label}: recovered partial JSON`);
        return recovered as T;
      }
      if (attempt === 0) console.warn(`[reconcile-propose] ${label}: parse failed, retrying…`);
      else console.warn(`[reconcile-propose] ${label}: all attempts failed.`);
    }
  }
  return null;
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      entityType: 'characters' | 'locations' | 'arcs';
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
    const { entityType, result, bookTitle, bookAuthor, chapterExcerpts } = body;

    if (!entityType || !result) {
      return NextResponse.json({ error: 'Missing entityType or result.' }, { status: 400 });
    }

    let system: string;
    let userPrompt: string;
    let entities: Array<{ name: string; aliases?: string[] }>;

    if (entityType === 'characters') {
      if (!result.characters?.length) {
        return NextResponse.json({ entityType, merges: [], splits: [] } satisfies ReconcileProposals);
      }
      system = CHAR_RECONCILE_SYSTEM;
      userPrompt = buildCharReconcilePrompt(bookTitle, bookAuthor, result.characters, chapterExcerpts);
      entities = result.characters.map((c) => ({ name: c.name, aliases: c.aliases }));
    } else if (entityType === 'locations') {
      if (!result.locations?.length) {
        return NextResponse.json({ entityType, merges: [], splits: [] } satisfies ReconcileProposals);
      }
      system = LOC_RECONCILE_SYSTEM;
      userPrompt = buildLocReconcilePrompt(bookTitle, bookAuthor, result.locations, result.characters, chapterExcerpts);
      entities = result.locations.map((l) => ({ name: l.name, aliases: l.aliases }));
    } else if (entityType === 'arcs') {
      if (!result.arcs?.length) {
        return NextResponse.json({ entityType, merges: [], splits: [] } satisfies ReconcileProposals);
      }
      system = ARC_RECONCILE_SYSTEM;
      userPrompt = buildArcReconcilePrompt(bookTitle, bookAuthor, result.arcs, result.characters);
      entities = result.arcs.map((a) => ({ name: a.name }));
    } else {
      return NextResponse.json({ error: `Unknown entityType: ${entityType}` }, { status: 400 });
    }

    const config = resolveConfig(body);
    if (body._ollamaContextLength && config.provider === 'ollama') {
      (config as { contextLengthOverride?: number }).contextLengthOverride = body._ollamaContextLength;
    }
    const { contextWindow } = await getContextWindow(config);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const emit = (ev: Record<string, unknown>) => controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
        try {
          emit({ phase: 'preparing', entityCount: entities.length, entityType });
          emit({ phase: 'calling_ai' });
          const rawResult = await callAndParseJSON<ReconcileResult<CharSplitEntry | LocSplitEntry | ArcSplitEntry>>(
            system, userPrompt, config, `${entityType}-propose`, contextWindow,
          );
          emit({ phase: 'parsing' });
          const proposals = (!rawResult || (!rawResult.mergeGroups?.length && !rawResult.splits?.length))
            ? { entityType, merges: [], splits: [] } satisfies ReconcileProposals
            : indexProposalsToNamed(entityType, entities, rawResult);
          emit({ phase: 'done', proposals });
        } catch (err) {
          emit({ phase: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[reconcile-propose] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
