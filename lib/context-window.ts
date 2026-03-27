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
