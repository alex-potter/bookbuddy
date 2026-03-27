// lib/context-window.ts

import { Agent, fetch as undiciFetch } from 'undici';
import type { ProviderType } from './rate-limiter';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChapterChunk {
  text: string;
  index: number;   // 0-based sub-chunk index
  total: number;   // total sub-chunks for this chapter
}

export interface ContextConfig {
  provider: ProviderType;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;
const OVERLAP_CHARS = 500;

// ─── Token estimation ────────────────────────────────────────────────────────

/** Estimate the number of tokens in a string. Conservative (3.5 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Convert a token count to approximate character count. */
export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

// ─── Ollama context detection ────────────────────────────────────────────────

const ollamaAgent = new Agent({ headersTimeout: 30_000, bodyTimeout: 30_000 });
const OLLAMA_DEFAULT_CTX = 4096;

/**
 * Query Ollama's /api/show endpoint to get the model's context window size.
 * The baseUrl from config typically points to "http://host:11434/v1" —
 * we strip "/v1" to reach the native Ollama API.
 */
async function getOllamaContextWindow(model: string, baseUrl?: string): Promise<number> {
  const v1Url = (baseUrl ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  // Strip /v1 or /v1/ suffix to get the Ollama native base
  const ollamaBase = v1Url.replace(/\/v1\/?$/, '');

  try {
    const res = await undiciFetch(`${ollamaBase}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      dispatcher: ollamaAgent,
    } as Parameters<typeof undiciFetch>[1]);

    if (!res.ok) {
      console.warn(`[context-window] Ollama /api/show returned ${res.status}, using default ${OLLAMA_DEFAULT_CTX}`);
      return OLLAMA_DEFAULT_CTX;
    }

    const data = await res.json() as {
      model_info?: Record<string, unknown>;
      parameters?: string;
    };

    // Strategy 1: model_info contains a key like "qwen2.5.context_length" or
    // "<arch>.context_length" with the numeric value
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
          console.log(`[context-window] Ollama model ${model}: context_length=${value} (from model_info)`);
          return value;
        }
      }
    }

    // Strategy 2: parameters string contains "num_ctx <number>"
    if (data.parameters) {
      const match = data.parameters.match(/num_ctx\s+(\d+)/);
      if (match) {
        const numCtx = parseInt(match[1], 10);
        console.log(`[context-window] Ollama model ${model}: num_ctx=${numCtx} (from parameters)`);
        return numCtx;
      }
    }

    console.warn(`[context-window] Ollama model ${model}: no context size found, using default ${OLLAMA_DEFAULT_CTX}`);
    return OLLAMA_DEFAULT_CTX;
  } catch (err) {
    console.warn(`[context-window] Ollama /api/show failed for ${model}:`, err instanceof Error ? err.message : err);
    return OLLAMA_DEFAULT_CTX;
  }
}

// ─── Cloud provider lookup tables ────────────────────────────────────────────

const ANTHROPIC_CONTEXT: Record<string, number> = {
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-5-20241022': 200_000,
  'claude-sonnet-4-6-20260320': 200_000,
  'claude-opus-4-6': 200_000,
};
const ANTHROPIC_DEFAULT_CTX = 100_000;

const GEMINI_CONTEXT: Record<string, number> = {
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
};
const GEMINI_DEFAULT_CTX = 128_000;

const OPENAI_COMPAT_DEFAULT_CTX = 8192;

async function getOpenAICompatibleContextWindow(model: string, baseUrl?: string, apiKey?: string): Promise<number> {
  if (!baseUrl || !model) return OPENAI_COMPAT_DEFAULT_CTX;
  const url = `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}`;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return OPENAI_COMPAT_DEFAULT_CTX;
    const data = await res.json() as Record<string, unknown>;
    const ctx = (data.context_length ?? data.context_window ?? data.max_model_len) as number | undefined;
    if (ctx && typeof ctx === 'number' && ctx > 0) {
      console.log(`[context-window] OpenAI-compatible model ${model}: context=${ctx}`);
      return ctx;
    }
  } catch {
    // ignore — use default
  }
  console.warn(`[context-window] OpenAI-compatible model ${model}: using default ${OPENAI_COMPAT_DEFAULT_CTX}`);
  return OPENAI_COMPAT_DEFAULT_CTX;
}

// ─── Unified context window detection ────────────────────────────────────────

/** Detect the context window size (in tokens) for the given provider and model. */
export async function getContextWindow(config: ContextConfig): Promise<number> {
  switch (config.provider) {
    case 'ollama':
      return getOllamaContextWindow(config.model, config.baseUrl);

    case 'anthropic': {
      if (ANTHROPIC_CONTEXT[config.model]) return ANTHROPIC_CONTEXT[config.model];
      for (const [prefix, ctx] of Object.entries(ANTHROPIC_CONTEXT)) {
        if (config.model.startsWith(prefix.split('-').slice(0, -1).join('-'))) return ctx;
      }
      return ANTHROPIC_DEFAULT_CTX;
    }

    case 'gemini': {
      if (GEMINI_CONTEXT[config.model]) return GEMINI_CONTEXT[config.model];
      for (const [prefix, ctx] of Object.entries(GEMINI_CONTEXT)) {
        if (config.model.startsWith(prefix)) return ctx;
      }
      return GEMINI_DEFAULT_CTX;
    }

    case 'openai-compatible':
      return getOpenAICompatibleContextWindow(config.model, config.baseUrl, config.apiKey);

    default:
      return OLLAMA_DEFAULT_CTX;
  }
}

// ─── Text budget calculation ─────────────────────────────────────────────────

/**
 * Compute the available character budget for chapter text in an LLM call.
 *
 * @param contextWindow  Total context window in tokens
 * @param outputReserve  Tokens reserved for the model's response
 * @param promptOverhead The non-text portion of the prompt (system + schema + entity lists + instructions) as a string
 * @returns Available characters for chapter text (minimum 500 to avoid degenerate splits)
 */
export function computeTextBudget(
  contextWindow: number,
  outputReserve: number,
  promptOverhead: string,
): number {
  const overheadTokens = estimateTokens(promptOverhead);
  const availableTokens = contextWindow - outputReserve - overheadTokens;
  const availableChars = tokensToChars(Math.max(availableTokens, 0));
  // Floor at 500 chars to avoid degenerate empty chunks
  return Math.max(availableChars, 500);
}

// ─── Chapter text splitting ──────────────────────────────────────────────────

/**
 * Split chapter text into sub-chunks that each fit within `availableChars`.
 * Splits at paragraph boundaries (\n\n), then line boundaries (\n), then
 * sentence boundaries (". "). Includes ~500 char overlap between chunks.
 *
 * Returns a single-element array if the text already fits.
 */
export function splitChapterText(text: string, availableChars: number): ChapterChunk[] {
  if (text.length <= availableChars) {
    return [{ text, index: 0, total: 1 }];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= availableChars) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point before the limit
    let splitAt = -1;
    const searchRegion = remaining.slice(0, availableChars);

    // Priority 1: paragraph boundary
    splitAt = searchRegion.lastIndexOf('\n\n');

    // Priority 2: line boundary
    if (splitAt < availableChars * 0.3) {
      const lineSplit = searchRegion.lastIndexOf('\n');
      if (lineSplit > splitAt) splitAt = lineSplit;
    }

    // Priority 3: sentence boundary
    if (splitAt < availableChars * 0.3) {
      const sentenceSplit = searchRegion.lastIndexOf('. ');
      if (sentenceSplit > splitAt) splitAt = sentenceSplit + 1; // include the period
    }

    // Fallback: hard split at the limit
    if (splitAt < availableChars * 0.1) {
      splitAt = availableChars;
    }

    chunks.push(remaining.slice(0, splitAt));
    // Advance with overlap: go back OVERLAP_CHARS from the split point
    const advance = Math.max(1, splitAt - OVERLAP_CHARS);
    remaining = remaining.slice(advance);
  }

  // Filter out whitespace-only chunks
  const filtered = chunks.filter((c) => c.trim().length > 0);
  return filtered.map((c, i) => ({ text: c, index: i, total: filtered.length }));
}
