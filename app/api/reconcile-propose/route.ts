import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import type { AnalysisResult } from '@/types';
import {
  CHAR_RECONCILE_SYSTEM, buildCharReconcilePrompt,
  LOC_RECONCILE_SYSTEM, buildLocReconcilePrompt,
  ARC_RECONCILE_SYSTEM, buildArcReconcilePrompt,
  indexProposalsToNamed,
  type ReconcileResult, type CharSplitEntry, type LocSplitEntry, type ArcSplitEntry,
  type ReconcileProposals,
} from '@/lib/reconcile';

// ─── LLM infrastructure (mirrored from reconcile/route.ts) ──────────────────

const ollamaAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const anthropic = new Anthropic();

type CallOpts = { baseUrl?: string; model?: string } | { apiKey?: string; model?: string };

async function callAnthropic(system: string, userPrompt: string, opts: { apiKey?: string; model?: string } = {}): Promise<string> {
  const client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : anthropic;
  const model = opts.model ?? 'claude-haiku-4-5-20251001';
  let fullText = '';

  for (let pass = 0; pass < 5; pass++) {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: userPrompt },
    ];
    if (fullText) {
      messages.push({ role: 'assistant', content: fullText });
    }

    const response = await client.messages.create({
      model,
      max_tokens: 16384,
      temperature: 0,
      system,
      messages,
    });

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') break;
    fullText += block.text;

    if (response.stop_reason !== 'max_tokens') break;
    console.log(`[reconcile-propose] Response hit max_tokens, continuing (pass ${pass + 1})…`);
  }

  if (!fullText) throw new Error('No text response from Anthropic.');
  return fullText;
}

async function callLocal(system: string, userPrompt: string, opts: { baseUrl?: string; model?: string } = {}, maxTokens = 16384): Promise<string> {
  const baseUrl = opts.baseUrl ?? process.env.LOCAL_MODEL_URL ?? 'http://localhost:11434/v1';
  const model = opts.model ?? process.env.LOCAL_MODEL_NAME ?? 'llama3.1:8b';
  const res = await undiciFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    dispatcher: ollamaAgent,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
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

function callLLM(system: string, userPrompt: string, useLocal: boolean, callOpts: CallOpts): Promise<string> {
  return useLocal
    ? callLocal(system, userPrompt, callOpts as { baseUrl?: string; model?: string })
    : callAnthropic(system, userPrompt, callOpts as { apiKey?: string; model?: string });
}

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
  system: string, userPrompt: string, useLocal: boolean, callOpts: CallOpts, label: string,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callLLM(system, userPrompt, useLocal, callOpts);
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const recovered = recoverPartialResponse(cleaned);
      if (recovered && Object.keys(recovered).length > 0) {
        console.log(`[reconcile-propose] ${label}: recovered partial JSON (keys: ${Object.keys(recovered).join(', ')})`);
        return recovered as T;
      }
      if (attempt === 0) {
        console.warn(`[reconcile-propose] ${label}: parse failed, retrying…`);
      } else {
        console.warn(`[reconcile-propose] ${label}: all attempts failed. Preview:`, cleaned.slice(-200));
      }
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
      _provider?: 'anthropic' | 'ollama';
      _apiKey?: string;
      _ollamaUrl?: string;
      _model?: string;
    };
    const { entityType, result, bookTitle, bookAuthor, chapterExcerpts, _provider, _apiKey, _ollamaUrl, _model } = body;

    if (!entityType || !result) {
      return NextResponse.json({ error: 'Missing entityType or result.' }, { status: 400 });
    }

    const serverHasKey = !!process.env.ANTHROPIC_API_KEY;
    const serverUsesLocal = process.env.USE_LOCAL_MODEL === 'true';
    const serverConfigured = serverHasKey || serverUsesLocal;
    const useLocal = serverConfigured ? serverUsesLocal : (_provider !== 'anthropic');
    const callOpts: CallOpts = useLocal
      ? { baseUrl: process.env.LOCAL_MODEL_URL ?? _ollamaUrl, model: process.env.LOCAL_MODEL_NAME ?? _model }
      : { apiKey: process.env.ANTHROPIC_API_KEY ?? _apiKey, model: _model };

    if (!useLocal && !(callOpts as { apiKey?: string }).apiKey) {
      return NextResponse.json(
        { error: 'No Anthropic API key configured.' },
        { status: 400 },
      );
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

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const emit = (ev: Record<string, unknown>) => controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
        try {
          emit({ phase: 'preparing', entityCount: entities.length, entityType });
          emit({ phase: 'calling_ai' });
          const rawResult = await callAndParseJSON<ReconcileResult<CharSplitEntry | LocSplitEntry | ArcSplitEntry>>(
            system, userPrompt, useLocal, callOpts, `${entityType}-propose`,
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
