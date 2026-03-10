/**
 * Client-side AI caller — used in mobile/APK builds (no Next.js server required).
 * Calls Anthropic or an Ollama-compatible endpoint directly from the browser.
 */

import type { AnalysisResult } from '@/types';
import {
  SYSTEM_PROMPT,
  buildFullPrompt,
  buildUpdatePrompt,
  truncateForFullAnalysis,
  truncateForDelta,
  mergeDelta,
  recoverPartialJson,
} from './ai-shared';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AiSettings {
  provider: 'anthropic' | 'ollama';
  anthropicKey: string;
  ollamaUrl: string;   // e.g. http://192.168.1.x:11434/v1
  model: string;
}

const SETTINGS_KEY = 'cc-ai-settings';

export function loadAiSettings(): AiSettings {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(SETTINGS_KEY) : null;
    if (raw) return JSON.parse(raw) as AiSettings;
  } catch { /* ignore */ }
  return {
    provider: 'ollama',
    anthropicKey: '',
    ollamaUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
  };
}

export function saveAiSettings(s: AiSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
  const res = await fetch(url, {
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

async function callAi(settings: AiSettings, userPrompt: string): Promise<string> {
  if (settings.provider === 'anthropic') {
    if (!settings.anthropicKey) throw new Error('Anthropic API key not set. Open Settings to configure.');
    return callAnthropic(settings.anthropicKey, settings.model || 'claude-haiku-4-5-20251001', SYSTEM_PROMPT, userPrompt);
  } else {
    if (!settings.ollamaUrl) throw new Error('Ollama URL not set. Open Settings to configure.');
    return callOllama(settings.ollamaUrl, settings.model || 'qwen2.5:14b', SYSTEM_PROMPT, userPrompt);
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
    return mergeDelta(previousResult!, delta);
  }
  return parsed as unknown as AnalysisResult;
}
