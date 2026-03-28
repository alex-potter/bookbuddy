/**
 * Client-side AI caller — used in mobile/APK builds (no Next.js server required).
 * Calls Anthropic, Gemini, OpenAI-compatible, or an Ollama endpoint directly from the browser.
 */

import type { AnalysisResult } from '@/types';
import type { ReconcileProposals } from './reconcile';
import {
  SYSTEM_PROMPT,
  buildFullPrompt,
  buildUpdatePrompt,
  truncateForFullAnalysis,
  truncateForDelta,
  mergeDelta,
  recoverPartialJson,
} from './ai-shared';
import { validateCharactersAgainstText, validateLocationsAgainstText } from './validate-entities';
import { waitIfNeeded, recordSuccess, recordRateLimit } from './rate-limiter';
import type { ProviderType } from './rate-limiter';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AiSettings {
  provider: 'anthropic' | 'ollama' | 'gemini' | 'openai-compatible';
  anthropicKey: string;
  ollamaUrl: string;   // e.g. http://192.168.1.x:11434/v1
  model: string;
  geminiKey: string;
  openaiCompatibleUrl: string;
  openaiCompatibleKey: string;
  openaiCompatibleName: string;
  ollamaContextLength?: number;         // user override
  ollamaDetectedContextLength?: number; // last auto-detected value
}

const SETTINGS_KEY = 'cc-ai-settings';

export function loadAiSettings(): AiSettings {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        provider: parsed.provider ?? 'ollama',
        anthropicKey: parsed.anthropicKey ?? '',
        ollamaUrl: parsed.ollamaUrl ?? 'http://localhost:11434/v1',
        model: parsed.model ?? 'qwen2.5:14b',
        geminiKey: parsed.geminiKey ?? '',
        openaiCompatibleUrl: parsed.openaiCompatibleUrl ?? '',
        openaiCompatibleKey: parsed.openaiCompatibleKey ?? '',
        openaiCompatibleName: parsed.openaiCompatibleName ?? '',
        ollamaContextLength: parsed.ollamaContextLength ?? undefined,
        ollamaDetectedContextLength: parsed.ollamaDetectedContextLength ?? undefined,
      };
    }
  } catch { /* ignore */ }
  return {
    provider: 'ollama',
    anthropicKey: '',
    ollamaUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    geminiKey: '',
    openaiCompatibleUrl: '',
    openaiCompatibleKey: '',
    openaiCompatibleName: '',
    ollamaContextLength: undefined,
    ollamaDetectedContextLength: undefined,
  };
}

export function saveAiSettings(s: AiSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// Ollama diagnostics
// ---------------------------------------------------------------------------

export interface OllamaDiagnostic {
  reachable: boolean;
  corsOk: boolean;
  hint?: string;
}

export async function diagnoseOllamaConnection(baseUrl: string): Promise<OllamaDiagnostic> {
  // Strip /v1 suffix to hit Ollama's root endpoint
  const rootUrl = baseUrl.replace(/\/v1\/?$/, '');

  // Phase 1: Reachability (no-cors → opaque response if server is up)
  try {
    await fetch(rootUrl, { mode: 'no-cors' });
  } catch {
    return { reachable: false, corsOk: false, hint: `Cannot reach Ollama at ${rootUrl}. Is it running? If using Safari, try Chrome or Firefox.` };
  }

  // Phase 2: CORS (cors mode → fails if no Access-Control-Allow-Origin)
  try {
    await fetch(rootUrl, { mode: 'cors' });
    return { reachable: true, corsOk: true };
  } catch {
    return { reachable: true, corsOk: false, hint: 'Ollama is running but blocking requests from this site. Set OLLAMA_ORIGINS=* and restart Ollama.' };
  }
}

/**
 * Query Ollama's /api/show from the browser to detect the model's default context window.
 * Returns the detected token count, or null on failure.
 */
export async function detectOllamaContextWindow(baseUrl: string, model: string): Promise<number | null> {
  const ollamaBase = baseUrl.replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${ollamaBase}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      model_info?: Record<string, unknown>;
      parameters?: string;
    };
    // Strategy 1: model_info key like "qwen2.5.context_length"
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
          return value;
        }
      }
    }
    // Strategy 2: parameters string "num_ctx <number>"
    if (data.parameters) {
      const match = data.parameters.match(/num_ctx\s+(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wrapped fetch for better Ollama errors
// ---------------------------------------------------------------------------

async function wrapOllamaFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('Ollama connection failed — likely a CORS issue. Open Settings → Test connection for setup instructions.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API callers
// ---------------------------------------------------------------------------

async function callAnthropic(apiKey: string, model: string, system: string, userPrompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error (${res.status}): ${err}`);
  }
  const data = await res.json();
  const text = data.content?.find((b: { type: string }) => b.type === 'text')?.text;
  if (!text) throw new Error('No text in Anthropic response.');
  return text;
}

async function callOllama(baseUrl: string, model: string, system: string, userPrompt: string): Promise<string> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const res = await wrapOllamaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 32768,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama error (${res.status}): ${err}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in Ollama response.');
  return text;
}

async function callGeminiClient(apiKey: string, model: string, system: string, userPrompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error (${res.status}): ${err}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text in Gemini response.');
  return text;
}

async function callOpenAICompatibleClient(baseUrl: string, apiKey: string, model: string, system: string, userPrompt: string): Promise<string> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userPrompt });
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: 8192, temperature: 0, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI-compatible error (${res.status}): ${err}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in response.');
  return text;
}

async function callAi(settings: AiSettings, userPrompt: string, systemOverride?: string): Promise<string> {
  const system = systemOverride ?? SYSTEM_PROMPT;
  const provider = settings.provider as ProviderType;
  await waitIfNeeded(provider);
  try {
    let result: string;
    switch (settings.provider) {
      case 'anthropic':
        if (!settings.anthropicKey) throw new Error('Anthropic API key not set. Open Settings to configure.');
        result = await callAnthropic(settings.anthropicKey, settings.model || 'claude-haiku-4-5-20251001', system, userPrompt);
        break;
      case 'gemini':
        if (!settings.geminiKey) throw new Error('Gemini API key not set. Open Settings to configure.');
        result = await callGeminiClient(settings.geminiKey, settings.model || 'gemini-2.0-flash', system, userPrompt);
        break;
      case 'openai-compatible':
        if (!settings.openaiCompatibleUrl) throw new Error('OpenAI-compatible URL not set. Open Settings to configure.');
        result = await callOpenAICompatibleClient(settings.openaiCompatibleUrl, settings.openaiCompatibleKey, settings.model, system, userPrompt);
        break;
      default: // ollama
        if (!settings.ollamaUrl) throw new Error('Ollama URL not set. Open Settings to configure.');
        result = await callOllama(settings.ollamaUrl, settings.model || 'qwen2.5:14b', system, userPrompt);
        break;
    }
    recordSuccess(provider);
    return result;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))) {
      recordRateLimit(provider);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Multi-turn book chat (used on mobile where there is no Next.js server)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function chatWithBook(
  systemPrompt: string,
  messages: ChatMessage[],
  settings: AiSettings,
): Promise<string> {
  switch (settings.provider) {
    case 'anthropic': {
      if (!settings.anthropicKey) throw new Error('No API key. Open Settings to configure.');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: settings.model || 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages,
        }),
      });
      if (!res.ok) throw new Error(`Anthropic error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      return data.content?.find((b: { type: string }) => b.type === 'text')?.text ?? '';
    }
    case 'gemini': {
      if (!settings.geminiKey) throw new Error('No Gemini key. Open Settings to configure.');
      const model = settings.model || 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiKey}`;
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const body: Record<string, unknown> = {
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0 },
      };
      if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Gemini error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }
    case 'openai-compatible': {
      if (!settings.openaiCompatibleUrl) throw new Error('No URL. Open Settings to configure.');
      const url = settings.openaiCompatibleUrl.replace(/\/$/, '') + '/chat/completions';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.openaiCompatibleKey) headers['Authorization'] = `Bearer ${settings.openaiCompatibleKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model,
          max_tokens: 1024,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      if (!res.ok) throw new Error(`Error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    }
    default: { // ollama
      if (!settings.ollamaUrl) throw new Error('No Ollama URL. Open Settings to configure.');
      const url = settings.ollamaUrl.replace(/\/$/, '') + '/chat/completions';
      const res = await wrapOllamaFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.model || 'qwen2.5:14b',
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    }
  }
}

// ---------------------------------------------------------------------------
// Connection test — lightweight ping to verify credentials/URL work
// ---------------------------------------------------------------------------

export async function testConnection(settings: AiSettings): Promise<string> {
  const ping = 'Reply with exactly one word: OK';
  switch (settings.provider) {
    case 'anthropic':
      if (!settings.anthropicKey) throw new Error('No API key entered.');
      return (await callAnthropic(settings.anthropicKey, settings.model || 'claude-haiku-4-5-20251001', 'You are a test assistant.', ping)).trim();
    case 'gemini':
      if (!settings.geminiKey) throw new Error('No Gemini API key entered.');
      return (await callGeminiClient(settings.geminiKey, settings.model || 'gemini-2.0-flash', 'You are a test assistant.', ping)).trim();
    case 'openai-compatible':
      if (!settings.openaiCompatibleUrl) throw new Error('No base URL entered.');
      return (await callOpenAICompatibleClient(settings.openaiCompatibleUrl, settings.openaiCompatibleKey, settings.model, 'You are a test assistant.', ping)).trim();
    default:
      if (!settings.ollamaUrl) throw new Error('No Ollama URL entered.');
      return (await callOllama(settings.ollamaUrl, settings.model || 'qwen2.5:14b', 'You are a test assistant.', ping)).trim();
  }
}

// ---------------------------------------------------------------------------
// Main analyze function (mirrors server-side route logic)
// ---------------------------------------------------------------------------

export async function analyzeChapterClient(
  bookTitle: string,
  bookAuthor: string,
  chapter: { title: string; text: string },
  previousResult: AnalysisResult | null,
): Promise<AnalysisResult> {
  const settings = loadAiSettings();
  const isDelta = !!previousResult;

  let userPrompt: string;
  if (isDelta) {
    const newText = `=== ${chapter.title} ===\n\n${chapter.text}`;
    userPrompt = buildUpdatePrompt(bookTitle, bookAuthor, chapter.title, previousResult, truncateForDelta(newText));
  } else {
    const fullText = `=== ${chapter.title} ===\n\n${chapter.text}`;
    userPrompt = buildFullPrompt(bookTitle, bookAuthor, chapter.title, truncateForFullAnalysis(fullText));
  }

  const raw = await callAi(settings, userPrompt);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const recovered = recoverPartialJson(cleaned, previousResult ?? undefined);
    if (!recovered) throw new Error('Model returned malformed JSON. Try again.');
    if (isDelta) return mergeDelta(previousResult!, { updatedCharacters: recovered.characters, summary: recovered.summary });
    return recovered;
  }

  if (isDelta) {
    const delta = parsed as { updatedCharacters?: AnalysisResult['characters']; updatedLocations?: AnalysisResult['locations']; summary?: string };
    // Validate delta entities against source text before merging
    if (delta.updatedCharacters?.length) {
      const { validated } = validateCharactersAgainstText(delta.updatedCharacters, chapter.text);
      delta.updatedCharacters = validated;
    }
    if (delta.updatedLocations?.length) {
      const { validated } = validateLocationsAgainstText(delta.updatedLocations, chapter.text);
      delta.updatedLocations = validated;
    }
    return mergeDelta(previousResult!, delta);
  }

  // Full analysis: validate entities against source text
  const result = parsed as unknown as AnalysisResult;
  if (result.characters?.length) {
    const { validated } = validateCharactersAgainstText(result.characters, chapter.text);
    result.characters = validated;
  }
  if (result.locations?.length) {
    const { validated } = validateLocationsAgainstText(result.locations, chapter.text);
    result.locations = validated.length > 0 ? validated : undefined;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Generic call-and-parse for client-side reconciliation
// ---------------------------------------------------------------------------

async function callAndParseClient<T>(
  settings: AiSettings,
  system: string,
  userPrompt: string,
  label: string,
): Promise<T | null> {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await callAi(settings, userPrompt, system);
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      try {
        return JSON.parse(cleaned) as T;
      } catch {
        const recovered = recoverPartialJson(cleaned);
        if (recovered) return recovered as unknown as T;
        if (attempt < maxRetries) {
          console.warn(`[${label}] JSON parse failed (attempt ${attempt + 1}), retrying…`);
          continue;
        }
        console.error(`[${label}] JSON parse failed after ${maxRetries + 1} attempts`);
        return null;
      }
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`[${label}] API error (attempt ${attempt + 1}), retrying…`, err);
        continue;
      }
      throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client-side reconciliation (mirrors server /api/reconcile)
// ---------------------------------------------------------------------------

export async function reconcileResultClient(
  bookTitle: string,
  bookAuthor: string,
  result: AnalysisResult,
  chapterExcerpts?: string,
): Promise<AnalysisResult> {
  const { reconcileResult } = await import('./reconcile');
  const settings = loadAiSettings();

  const callAndParse = async <T>(system: string, userPrompt: string, label: string): Promise<T | null> => {
    return callAndParseClient<T>(settings, system, userPrompt, label);
  };

  return reconcileResult(result, bookTitle, bookAuthor, chapterExcerpts, callAndParse);
}

// ---------------------------------------------------------------------------
// Client-side reconcile-propose (mirrors server /api/reconcile-propose)
// ---------------------------------------------------------------------------

export async function reconcileProposeClient(
  entityType: 'characters' | 'locations' | 'arcs',
  result: AnalysisResult,
  bookTitle: string,
  bookAuthor: string,
  chapterExcerpts?: string,
): Promise<ReconcileProposals> {
  const {
    CHAR_RECONCILE_SYSTEM, buildCharReconcilePrompt, indexProposalsToNamed,
    LOC_RECONCILE_SYSTEM, buildLocReconcilePrompt,
    ARC_RECONCILE_SYSTEM, buildArcReconcilePrompt,
  } = await import('./reconcile');
  const settings = loadAiSettings();

  let system: string;
  let userPrompt: string;
  const characters = result.characters ?? [];
  const locations = result.locations ?? [];
  const arcs = result.arcs ?? [];

  if (entityType === 'characters') {
    system = CHAR_RECONCILE_SYSTEM;
    userPrompt = buildCharReconcilePrompt(bookTitle, bookAuthor, characters, chapterExcerpts);
  } else if (entityType === 'locations') {
    system = LOC_RECONCILE_SYSTEM;
    userPrompt = buildLocReconcilePrompt(bookTitle, bookAuthor, locations, characters, chapterExcerpts);
  } else {
    system = ARC_RECONCILE_SYSTEM;
    userPrompt = buildArcReconcilePrompt(bookTitle, bookAuthor, arcs, characters);
  }

  const raw = await callAndParseClient<{ mergeGroups?: unknown[]; splits?: unknown[] }>(
    settings, system, userPrompt, `reconcile-propose-${entityType}`,
  );

  if (!raw) {
    return { entityType, merges: [], splits: [] };
  }

  const entities = entityType === 'characters' ? characters
    : entityType === 'locations' ? locations
    : arcs;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return indexProposalsToNamed(entityType, entities as any, raw as any);
}
