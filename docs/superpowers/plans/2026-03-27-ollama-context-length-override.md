# Ollama Context Length Override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set the Ollama context length via a slider in Settings, so the app's chunk budgeting matches the actual runtime `num_ctx`.

**Architecture:** Add `ollamaContextLength` and `ollamaDetectedContextLength` fields to the existing `AiSettings` interface. The SettingsModal gets a slider+input+reset control in the Ollama section. The slider auto-detects from `/api/show` on load and model change, but users can override it. The override flows through the existing `_`-prefixed request body fields to the server's `getContextWindow()`, which skips the `/api/show` query when an override is present.

**Tech Stack:** React 18, Next.js 14, TypeScript, Tailwind CSS, Ollama API

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/ai-client.ts` | Modify | Add `ollamaContextLength` and `ollamaDetectedContextLength` to `AiSettings`; add `detectOllamaContextWindow()` helper |
| `lib/context-window.ts` | Modify | Add optional `contextLengthOverride` to `ContextConfig`; use it instead of querying `/api/show` when set; update logging |
| `components/SettingsModal.tsx` | Modify | Add context length slider + numeric input + "Reset to detected" button in Ollama section |
| `app/page.tsx` | Modify | Pass `ollamaContextLength` as `_ollamaContextLength` in request body |
| `app/api/analyze/route.ts` | Modify | Read `_ollamaContextLength` from body; pass as `contextLengthOverride` in `ContextConfig` |
| `lib/llm.ts` | Modify | Add `_ollamaContextLength` to `RequestBody` interface |

---

### Task 1: Add context length fields to AiSettings

**Files:**
- Modify: `lib/ai-client.ts:25-65` (AiSettings interface + load/save)

- [ ] **Step 1: Add fields to AiSettings interface**

In `lib/ai-client.ts`, add two new optional fields to the `AiSettings` interface:

```typescript
export interface AiSettings {
  provider: 'anthropic' | 'ollama' | 'gemini' | 'openai-compatible';
  anthropicKey: string;
  ollamaUrl: string;
  model: string;
  geminiKey: string;
  openaiCompatibleUrl: string;
  openaiCompatibleKey: string;
  openaiCompatibleName: string;
  ollamaContextLength?: number;         // user override
  ollamaDetectedContextLength?: number; // last auto-detected value
}
```

- [ ] **Step 2: Update loadAiSettings to read the new fields**

In the `loadAiSettings` function, add parsing for the new fields after the existing fields:

```typescript
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
```

No changes needed to `saveAiSettings` — it already calls `JSON.stringify(s)` which includes all fields.

- [ ] **Step 3: Add detectOllamaContextWindow helper**

Add a new exported function in `lib/ai-client.ts` after the `diagnoseOllamaConnection` function (after line 99). This is a client-side helper that queries Ollama's `/api/show` endpoint from the browser:

```typescript
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
```

- [ ] **Step 4: Verify the app still builds**

Run: `npx next build`
Expected: Build succeeds with no type errors related to AiSettings.

- [ ] **Step 5: Commit**

```bash
git add lib/ai-client.ts
git commit -m "feat: add context length fields to AiSettings and detect helper"
```

---

### Task 2: Accept context length override in context-window.ts

**Files:**
- Modify: `lib/context-window.ts:14-19` (ContextConfig interface)
- Modify: `lib/context-window.ts:143-170` (getContextWindow function)

- [ ] **Step 1: Add contextLengthOverride to ContextConfig**

In `lib/context-window.ts`, add the optional field to `ContextConfig`:

```typescript
export interface ContextConfig {
  provider: ProviderType;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextLengthOverride?: number; // user-set context length (Ollama only)
}
```

- [ ] **Step 2: Update getContextWindow to use override for Ollama**

Replace the `ollama` case in `getContextWindow`:

```typescript
export async function getContextWindow(config: ContextConfig): Promise<{ contextWindow: number; source: 'user-override' | 'auto-detected' }> {
  switch (config.provider) {
    case 'ollama': {
      if (config.contextLengthOverride && config.contextLengthOverride > 0) {
        console.log(`[context-window] Ollama model ${config.model}: context=${config.contextLengthOverride} (user override)`);
        return { contextWindow: config.contextLengthOverride, source: 'user-override' };
      }
      const detected = await getOllamaContextWindow(config.model, config.baseUrl);
      console.log(`[context-window] Ollama model ${config.model}: context=${detected} (auto-detected)`);
      return { contextWindow: detected, source: 'auto-detected' };
    }

    case 'anthropic': {
      if (ANTHROPIC_CONTEXT[config.model]) return { contextWindow: ANTHROPIC_CONTEXT[config.model], source: 'auto-detected' };
      for (const [prefix, ctx] of Object.entries(ANTHROPIC_CONTEXT)) {
        if (config.model.startsWith(prefix.split('-').slice(0, -1).join('-'))) return { contextWindow: ctx, source: 'auto-detected' };
      }
      return { contextWindow: ANTHROPIC_DEFAULT_CTX, source: 'auto-detected' };
    }

    case 'gemini': {
      if (GEMINI_CONTEXT[config.model]) return { contextWindow: GEMINI_CONTEXT[config.model], source: 'auto-detected' };
      for (const [prefix, ctx] of Object.entries(GEMINI_CONTEXT)) {
        if (config.model.startsWith(prefix)) return { contextWindow: ctx, source: 'auto-detected' };
      }
      return { contextWindow: GEMINI_DEFAULT_CTX, source: 'auto-detected' };
    }

    case 'openai-compatible': {
      const ctx = await getOpenAICompatibleContextWindow(config.model, config.baseUrl, config.apiKey);
      return { contextWindow: ctx, source: 'auto-detected' };
    }

    default:
      return { contextWindow: OLLAMA_DEFAULT_CTX, source: 'auto-detected' };
  }
}
```

- [ ] **Step 3: Verify the app still builds**

Run: `npx next build`
Expected: Build will FAIL because `getContextWindow` now returns `{ contextWindow, source }` instead of a plain number. This is expected — we fix the caller in the next task.

- [ ] **Step 4: Commit**

```bash
git add lib/context-window.ts
git commit -m "feat: accept context length override in getContextWindow"
```

---

### Task 3: Update analyze route to pass and use context length override

**Files:**
- Modify: `lib/llm.ts:404-412` (RequestBody interface)
- Modify: `app/api/analyze/route.ts:1753-1756` (getContextWindow call site)

- [ ] **Step 1: Add _ollamaContextLength to RequestBody in llm.ts**

In `lib/llm.ts`, add the new field to the `RequestBody` interface:

```typescript
interface RequestBody {
  _provider?: string;
  _apiKey?: string;
  _ollamaUrl?: string;
  _model?: string;
  _geminiKey?: string;
  _openaiCompatibleUrl?: string;
  _openaiCompatibleKey?: string;
  _ollamaContextLength?: number;
}
```

- [ ] **Step 2: Update analyze route to destructure the new return type and pass override**

In `app/api/analyze/route.ts`, find the block around line 1743-1756 and update it. First, read `_ollamaContextLength` from the body (it's already destructured via `const body = await req.json()`). Then pass it to `getContextWindow` and destructure the new return shape:

Replace:
```typescript
    const config = resolveConfig(body);
```
with:
```typescript
    const config = resolveConfig(body);
    // Pass user's context length override for Ollama
    if (body._ollamaContextLength && config.provider === 'ollama') {
      (config as { contextLengthOverride?: number }).contextLengthOverride = body._ollamaContextLength;
    }
```

Replace:
```typescript
    // Detect context window for this provider/model
    const contextWindow = await getContextWindow(config);
    console.log(`[analyze] Context window: ${contextWindow} tokens (${config.provider}/${config.model})`);
```
with:
```typescript
    // Detect context window for this provider/model
    const { contextWindow, source } = await getContextWindow(config);
    console.log(`[analyze] Context window: ${contextWindow} tokens (${source}) [${config.provider}/${config.model}]`);
```

- [ ] **Step 3: Verify the app builds**

Run: `npx next build`
Expected: Build succeeds. The `getContextWindow` return type change is now handled.

- [ ] **Step 4: Commit**

```bash
git add lib/llm.ts app/api/analyze/route.ts
git commit -m "feat: pass context length override through analyze route"
```

---

### Task 4: Pass context length from client to server

**Files:**
- Modify: `app/page.tsx:223-235` (analyzeChapter function, aiSettings block)

- [ ] **Step 1: Add ollamaContextLength to the request body**

In `app/page.tsx`, in the `analyzeChapter` function, find the block that populates `aiSettings` (around lines 224-235). Add one line after the `_ollamaUrl` line:

```typescript
  let aiSettings: Record<string, string | number> = {};
  try {
    const { loadAiSettings } = await import('@/lib/ai-client');
    const s = loadAiSettings();
    if (s.provider) aiSettings._provider = s.provider;
    if (s.anthropicKey) aiSettings._apiKey = s.anthropicKey;
    if (s.ollamaUrl) aiSettings._ollamaUrl = s.ollamaUrl;
    if (s.model) aiSettings._model = s.model;
    if (s.geminiKey) aiSettings._geminiKey = s.geminiKey;
    if (s.openaiCompatibleUrl) aiSettings._openaiCompatibleUrl = s.openaiCompatibleUrl;
    if (s.openaiCompatibleKey) aiSettings._openaiCompatibleKey = s.openaiCompatibleKey;
    if (s.ollamaContextLength) aiSettings._ollamaContextLength = s.ollamaContextLength;
  } catch { /* ignore — server will use env vars */ }
```

Note: The type of `aiSettings` changes from `Record<string, string>` to `Record<string, string | number>` since `ollamaContextLength` is a number.

- [ ] **Step 2: Verify the app builds**

Run: `npx next build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: send ollamaContextLength from client to analyze API"
```

---

### Task 5: Add context length slider to SettingsModal

**Files:**
- Modify: `components/SettingsModal.tsx:1-185` (Ollama config section)

- [ ] **Step 1: Add state for detected context length and detection status**

In `SettingsModal.tsx`, add new state variables after the existing `useState` calls (after line 24):

```typescript
  const [detectedCtx, setDetectedCtx] = useState<number | null>(settings.ollamaDetectedContextLength ?? null);
  const [detectingCtx, setDetectingCtx] = useState(false);
  const [detectError, setDetectError] = useState(false);
```

- [ ] **Step 2: Add auto-detect function**

Add a function after the existing `handleTest` function (after line 64):

```typescript
  async function detectContextLength(url?: string, model?: string) {
    const baseUrl = url ?? settings.ollamaUrl;
    const modelName = model ?? settings.model;
    if (!baseUrl || !modelName) return;
    setDetectingCtx(true);
    setDetectError(false);
    try {
      const { detectOllamaContextWindow } = await import('@/lib/ai-client');
      const detected = await detectOllamaContextWindow(baseUrl, modelName);
      if (detected) {
        setDetectedCtx(detected);
        setSettings((prev) => ({
          ...prev,
          ollamaDetectedContextLength: detected,
          // Only set the slider value if user hasn't overridden it
          ...(prev.ollamaContextLength ? {} : { ollamaContextLength: detected }),
        }));
      } else {
        setDetectedCtx(null);
        setDetectError(true);
      }
    } catch {
      setDetectedCtx(null);
      setDetectError(true);
    } finally {
      setDetectingCtx(false);
    }
  }
```

- [ ] **Step 3: Update model change handler to reset context length**

Find the model preset buttons section (around line 129-138). Wrap the existing `set('model', m)` call to also trigger detection for the new model. Replace the onClick for model preset buttons:

```typescript
  {OLLAMA_MODELS.map((m) => (
    <button
      key={m}
      onClick={() => {
        set('model', m);
        // Reset context override when model changes, then detect new default
        setSettings((prev) => ({ ...prev, model: m, ollamaContextLength: undefined }));
        detectContextLength(undefined, m);
      }}
      className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${settings.model === m ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-600 hover:border-stone-400 dark:hover:border-zinc-500 hover:text-stone-600 dark:hover:text-zinc-400'}`}
    >
      {m}
    </button>
  ))}
```

Also update the model text input `onChange` to clear the override when the user types a new model name. Replace the model input onChange:

```typescript
  onChange={(e) => {
    set('model', e.target.value);
    setSettings((prev) => ({ ...prev, model: e.target.value, ollamaContextLength: undefined }));
  }}
```

- [ ] **Step 4: Add the context length slider UI**

After the model section's closing `</div>` (after line 139, before the Ollama Setup Guide section), add the context length control:

```tsx
            {/* Context Length */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500">Context Length (tokens)</label>
                {settings.ollamaContextLength && detectedCtx && settings.ollamaContextLength !== detectedCtx && (
                  <button
                    onClick={() => {
                      setSettings((prev) => ({ ...prev, ollamaContextLength: detectedCtx }));
                      setSaved(false);
                    }}
                    className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                  >
                    Reset to detected
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={2048}
                  max={131072}
                  step={1024}
                  value={settings.ollamaContextLength ?? detectedCtx ?? 4096}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setSettings((prev) => ({ ...prev, ollamaContextLength: val }));
                    setSaved(false);
                  }}
                  className="flex-1 accent-amber-500"
                />
                <input
                  type="number"
                  min={2048}
                  max={131072}
                  step={1024}
                  value={settings.ollamaContextLength ?? detectedCtx ?? 4096}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 2048) {
                      setSettings((prev) => ({ ...prev, ollamaContextLength: val }));
                      setSaved(false);
                    }
                  }}
                  className="w-24 bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-stone-800 dark:text-zinc-200 text-right font-mono focus:outline-none focus:border-amber-500/50"
                />
              </div>
              <p className="mt-1 text-[10px] text-stone-400 dark:text-zinc-600">
                {detectingCtx ? 'Detecting…' : detectError ? 'Could not detect — using default 4096. Adjust to match your Ollama setting.' : detectedCtx ? `Auto-detected: ${detectedCtx.toLocaleString()}` : 'Set this to match the context length in your Ollama app.'}
                {settings.ollamaContextLength && detectedCtx && settings.ollamaContextLength !== detectedCtx && (
                  <span className="ml-1 text-amber-500/70">(overridden)</span>
                )}
              </p>
            </div>
```

- [ ] **Step 5: Trigger detection on Test Connection success**

Update the `handleTest` function. After the successful test (where `setTestState('ok')` is called, around line 58), add a call to detect context length — but only if the user hasn't manually overridden:

Replace:
```typescript
      const reply = await testConnection(settings);
      setTestState('ok');
      setTestMsg(reply.slice(0, 80));
```
with:
```typescript
      const reply = await testConnection(settings);
      setTestState('ok');
      setTestMsg(reply.slice(0, 80));
      // After successful connection, detect context window
      if (settings.provider === 'ollama') {
        detectContextLength();
      }
```

- [ ] **Step 6: Trigger initial detection on mount for Ollama**

Add a `useEffect` to detect context length when the modal opens with Ollama selected. Add this after the state declarations (after the `detectError` state line):

First, add `useEffect` to the import:
```typescript
import { useState, useEffect } from 'react';
```

Then add the effect:
```typescript
  // Auto-detect context length when modal opens with Ollama selected
  useEffect(() => {
    if (settings.provider === 'ollama' && settings.ollamaUrl && settings.model && !detectedCtx) {
      detectContextLength();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 7: Verify the app builds and the slider renders**

Run: `npx next dev`
Open the app, go to Settings, select Ollama. Expected: The context length slider appears below the model field. If Ollama is running, it auto-detects the context window. The slider and numeric input are synced.

- [ ] **Step 8: Commit**

```bash
git add components/SettingsModal.tsx
git commit -m "feat: add context length slider to Ollama settings"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Test auto-detection**

1. Start Ollama with a model (e.g., `ollama run qwen2.5:32b`)
2. Open the app, go to Settings, select Ollama
3. Expected: Slider shows the detected value (e.g., 32768). Label shows "Auto-detected: 32,768"

- [ ] **Step 2: Test user override**

1. Move the slider to 16384
2. Click Save
3. Analyze a chapter
4. Check terminal output: should show "Context window: 16384 tokens (user-override)"

- [ ] **Step 3: Test model change resets override**

1. Set context length to 16384
2. Click a different model preset (e.g., `llama3.1:8b`)
3. Expected: Slider resets and re-detects for the new model

- [ ] **Step 4: Test Reset to detected**

1. With an override active, click "Reset to detected"
2. Expected: Slider returns to the auto-detected value

- [ ] **Step 5: Test persistence**

1. Set context length to 16384, click Save
2. Close and reopen Settings
3. Expected: Slider still shows 16384

- [ ] **Step 6: Commit final state and push**

```bash
git push origin main
```
