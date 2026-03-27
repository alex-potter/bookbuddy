// lib/llm.ts

import Anthropic from '@anthropic-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import * as rateLimiter from './rate-limiter';
import type { ProviderType } from './rate-limiter';

export type { ProviderType };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LLMCallConfig {
  provider: ProviderType;
  model: string;
  system: string;
  userPrompt: string;  // ignored when messages is provided (caller puts query in messages)
  maxTokens: number;
  jsonMode?: boolean;
  temperature?: number;       // defaults to 0
  messages?: Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }> }>;
  images?: Array<{ data: string; mimeType: string }>;
  apiKey?: string;
  baseUrl?: string;
}

export interface LLMResult {
  text: string;
  rateLimitWaitMs?: number;
}

export interface ResolveConfigOverrides {
  defaultAnthropicModel?: string;
  defaultOllamaModel?: string;
  defaultGeminiModel?: string;
  useVisionModel?: boolean;
}

// ─── Shared infrastructure ───────────────────────────────────────────────────

const ollamaAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const TIMEOUT_MS = 300_000; // 5 minutes for cloud providers

// Anthropic client cache — keyed by API key to avoid creating new clients per call
const anthropicClients = new Map<string, Anthropic>();
function getAnthropicClient(apiKey?: string): Anthropic {
  const key = apiKey ?? 'default';
  let client = anthropicClients.get(key);
  if (!client) {
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    anthropicClients.set(key, client);
  }
  return client;
}

// ─── Provider callers ────────────────────────────────────────────────────────

async function callAnthropicProvider(config: LLMCallConfig): Promise<string> {
  const client = getAnthropicClient(config.apiKey);
  const model = config.model || 'claude-haiku-4-5-20251001';
  let fullText = '';

  // Continuation loop: if the response hits max_tokens, prefill the assistant
  // turn with what we have so far and let the model continue where it left off.
  for (let pass = 0; pass < 5; pass++) {
    const messages: Anthropic.MessageParam[] = [];

    if (config.messages?.length) {
      // Multi-turn chat mode
      for (const m of config.messages) {
        messages.push({ role: m.role as 'user' | 'assistant', content: m.content as string });
      }
    } else if (config.images?.length) {
      // Vision mode
      const content: Anthropic.ContentBlockParam[] = config.images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: img.data },
      }));
      content.push({ type: 'text' as const, text: config.userPrompt });
      messages.push({ role: 'user', content });
    } else {
      // Standard single-turn
      messages.push({ role: 'user', content: config.userPrompt });
    }

    if (fullText) {
      messages.push({ role: 'assistant', content: fullText });
    }

    const response = await client.messages.create({
      model,
      max_tokens: config.maxTokens,
      temperature: config.temperature ?? 0,
      system: config.system || undefined,
      messages,
    });

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') break;
    fullText += block.text;

    if (response.stop_reason !== 'max_tokens') break;
    console.log(`[llm] Anthropic response hit max_tokens, continuing (pass ${pass + 1})…`);
  }

  if (!fullText) throw new Error('No text response from Anthropic.');
  return fullText;
}

async function callOllamaProvider(config: LLMCallConfig): Promise<string> {
  const baseUrl = (config.baseUrl ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  const model = config.model || 'qwen2.5:14b';

  const messages: Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }> }> = [];

  if (config.messages?.length) {
    if (config.system) messages.push({ role: 'system', content: config.system });
    messages.push(...config.messages);
  } else if (config.images?.length) {
    if (config.system) messages.push({ role: 'system', content: config.system });
    const content: Array<{ type: string; [key: string]: unknown }> = config.images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    }));
    content.push({ type: 'text', text: config.userPrompt });
    messages.push({ role: 'user', content });
  } else {
    if (config.system) messages.push({ role: 'system', content: config.system });
    messages.push({ role: 'user', content: config.userPrompt });
  }

  const body: Record<string, unknown> = {
    model,
    temperature: config.temperature ?? 0,
    max_tokens: config.maxTokens,
    messages,
  };
  if (config.jsonMode) body.response_format = { type: 'json_object' };

  const res = await undiciFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    dispatcher: ollamaAgent,
    body: JSON.stringify(body),
  } as Parameters<typeof undiciFetch>[1]);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama error (${res.status}): ${err}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in Ollama response.');
  return text;
}

async function callGeminiProvider(config: LLMCallConfig, retried = false): Promise<string> {
  if (!config.apiKey) throw new Error('Gemini API key not configured. Open Settings to add your key.');
  const model = config.model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (config.images?.length) {
    for (const img of config.images) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }
  parts.push({ text: config.userPrompt });

  const contents: Array<{ role: string; parts: typeof parts }> = [];

  if (config.messages?.length) {
    // Multi-turn chat: map messages to Gemini format
    for (const m of config.messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const msgParts: typeof parts = [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }];
      contents.push({ role, parts: msgParts });
    }
    // Append images to the last user turn if present
    if (config.images?.length) {
      const imgParts: typeof parts = config.images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
      const lastUser = [...contents].reverse().find((c) => c.role === 'user');
      if (lastUser) lastUser.parts.push(...imgParts);
      else contents.push({ role: 'user', parts: imgParts });
    }
  } else {
    contents.push({ role: 'user', parts });
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: config.maxTokens,
      temperature: config.temperature ?? 0,
    },
  };

  if (config.system) {
    body.systemInstruction = { parts: [{ text: config.system }] };
  }
  if (config.jsonMode) {
    (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error (${res.status}): ${err}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text in Gemini response.');

  // Handle truncation: retry once with more tokens
  if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS' && !retried) {
    console.log('[llm] Gemini response truncated, retrying with more tokens…');
    return callGeminiProvider({ ...config, maxTokens: Math.ceil(config.maxTokens * 1.5) }, true);
  }

  return text;
}

async function callOpenAICompatibleProvider(config: LLMCallConfig, retried = false): Promise<string> {
  if (!config.baseUrl) throw new Error('OpenAI-compatible base URL not configured. Open Settings.');
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const model = config.model;
  if (!model) throw new Error('No model specified for OpenAI-compatible provider. Open Settings to configure.');

  const messages: Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }> }> = [];

  if (config.messages?.length) {
    if (config.system) messages.push({ role: 'system', content: config.system });
    messages.push(...config.messages);
  } else if (config.images?.length) {
    const content: Array<{ type: string; [key: string]: unknown }> = config.images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    }));
    content.push({ type: 'text', text: config.userPrompt });
    if (config.system) messages.push({ role: 'system', content: config.system });
    messages.push({ role: 'user', content });
  } else {
    if (config.system) messages.push({ role: 'system', content: config.system });
    messages.push({ role: 'user', content: config.userPrompt });
  }

  const body: Record<string, unknown> = {
    model,
    temperature: config.temperature ?? 0,
    max_tokens: config.maxTokens,
    messages,
  };
  if (config.jsonMode) body.response_format = { type: 'json_object' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI-compatible error (${res.status}): ${err}`);
  }

  const data = await res.json() as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in OpenAI-compatible response.');

  // Handle truncation: retry once with more tokens
  if (data.choices?.[0]?.finish_reason === 'length' && !retried) {
    console.log('[llm] OpenAI-compatible response truncated, retrying with more tokens…');
    return callOpenAICompatibleProvider({ ...config, maxTokens: Math.ceil(config.maxTokens * 1.5) }, true);
  }

  return text;
}

// ─── Dispatch + rate limiting ────────────────────────────────────────────────

function dispatch(config: LLMCallConfig): Promise<string> {
  switch (config.provider) {
    case 'anthropic': return callAnthropicProvider(config);
    case 'ollama': return callOllamaProvider(config);
    case 'gemini': return callGeminiProvider(config);
    case 'openai-compatible': return callOpenAICompatibleProvider(config);
    default: throw new Error(`Unknown provider: ${config.provider}`);
  }
}

function isRateLimitError(err: unknown): err is Error & { status?: number; response?: { headers?: Headers } } {
  if (err instanceof Error) {
    if ('status' in err && (err as { status?: number }).status === 429) return true;
    if (err.message.includes('429') || err.message.toLowerCase().includes('rate limit')) return true;
  }
  return false;
}

function extractHeaders(err: unknown): Headers | undefined {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { headers?: Headers } }).response;
    return resp?.headers;
  }
  return undefined;
}

export async function callLLM(config: LLMCallConfig): Promise<LLMResult> {
  const maxRetries = 3;
  let totalWaitMs = 0;

  for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
    const paceWait = await rateLimiter.waitIfNeeded(config.provider);
    totalWaitMs += paceWait;

    try {
      const text = await dispatch(config);
      rateLimiter.recordSuccess(config.provider);
      return { text, rateLimitWaitMs: totalWaitMs || undefined };
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxRetries) throw err;
      const retryAfterMs = rateLimiter.parseRetryAfter(extractHeaders(err));
      const waitMs = rateLimiter.recordRateLimit(config.provider, retryAfterMs);
      console.warn(`[llm] Rate limited by ${config.provider}, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})…`);
      await new Promise((r) => setTimeout(r, waitMs));
      totalWaitMs += waitMs;
    }
  }
  throw new Error(`Rate limit exceeded after ${maxRetries} retries`);
}

// ─── Config resolution ───────────────────────────────────────────────────────

interface RequestBody {
  _provider?: string;
  _apiKey?: string;
  _ollamaUrl?: string;
  _model?: string;
  _geminiKey?: string;
  _openaiCompatibleUrl?: string;
  _openaiCompatibleKey?: string;
}

export function resolveConfig(body: RequestBody, overrides?: ResolveConfigOverrides): Omit<LLMCallConfig, 'system' | 'userPrompt' | 'maxTokens'> {
  const provider = (body._provider ?? 'ollama') as ProviderType;

  switch (provider) {
    case 'anthropic': {
      const serverKey = process.env.ANTHROPIC_API_KEY;
      return {
        provider,
        model: body._model ?? overrides?.defaultAnthropicModel ?? 'claude-haiku-4-5-20251001',
        apiKey: serverKey ?? body._apiKey,
      };
    }
    case 'ollama': {
      const serverConfigured = process.env.USE_LOCAL_MODEL === 'true';
      const useVision = overrides?.useVisionModel;
      const defaultModel = useVision
        ? (process.env.LOCAL_VISION_MODEL_NAME ?? 'qwen2.5vl:7b')
        : (overrides?.defaultOllamaModel ?? 'qwen2.5:14b');
      return {
        provider,
        model: (serverConfigured ? (useVision ? process.env.LOCAL_VISION_MODEL_NAME : process.env.LOCAL_MODEL_NAME) : body._model) ?? defaultModel,
        baseUrl: (serverConfigured ? process.env.LOCAL_MODEL_URL : body._ollamaUrl) ?? 'http://localhost:11434/v1',
      };
    }
    case 'gemini': {
      const serverKey = process.env.GEMINI_API_KEY;
      return {
        provider,
        model: body._model ?? overrides?.defaultGeminiModel ?? 'gemini-2.0-flash',
        apiKey: serverKey ?? body._geminiKey,
      };
    }
    case 'openai-compatible': {
      const serverUrl = process.env.OPENAI_COMPATIBLE_URL;
      const serverConfigured = !!serverUrl;
      return {
        provider,
        model: (serverConfigured ? process.env.OPENAI_COMPATIBLE_MODEL : body._model) ?? '',
        apiKey: (serverConfigured ? process.env.OPENAI_COMPATIBLE_KEY : body._openaiCompatibleKey) ?? '',
        baseUrl: serverUrl ?? body._openaiCompatibleUrl ?? '',
      };
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
