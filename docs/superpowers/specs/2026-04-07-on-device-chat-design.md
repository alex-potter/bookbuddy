# On-Device AI Chat for Mobile

**Date:** 2026-04-07
**Status:** Draft
**Scope:** Chat only (book analysis remains cloud-provider-only)

## Problem

Mobile BookBuddy users currently need either a paid API key (Anthropic, Gemini) or a local Ollama server on their network to use the chat feature. There is no zero-cost, works-anywhere option for chatting about books using the data stored in .bookbuddy files.

## Solution

Add on-device LLM inference via a native Capacitor plugin wrapping llama.cpp. Users download a small model file (~1.3 GB) once, and chat runs entirely on their phone with no network connection or API key required.

## Architecture

Three layers:

1. **Capacitor Plugin (`capacitor-llama`)** — Native Kotlin (Android) and Swift (iOS, future) code adapted from [llama.rn](https://github.com/mybigday/llama.rn) that wraps llama.cpp. Handles model file I/O, memory management, and inference threading.

2. **Model Manager (`lib/local-llm.ts`)** — TypeScript layer that orchestrates model downloads with progress tracking, persists which models are installed, and manages the load/unload lifecycle.

3. **Provider Integration** — The existing `AiSettings.provider` union gains a `'local'` option. `chatWithBook()` in `ai-client.ts` gets a new case that calls the Capacitor plugin. The `SettingsModal` gets a new panel for local model management.

The chat flow is unchanged: `ChatPanel` builds a system prompt from bookbuddy snapshot data, passes it with the message history to `chatWithBook()`, and the local provider handles inference on-device instead of making an HTTP request.

## Capacitor Plugin API

The plugin (`capacitor-llama`) exposes a minimal interface:

```typescript
interface LlamaPlugin {
  // Model management
  downloadModel(options: { url: string; fileName: string }): Promise<void>;
  // Emits 'downloadProgress' events via Capacitor's plugin event system:
  // addListener('downloadProgress', (data: { bytesDownloaded: number; totalBytes: number }) => void)
  deleteModel(options: { fileName: string }): Promise<void>;
  listModels(): Promise<{ models: Array<{ fileName: string; sizeBytes: number }> }>;

  // Inference
  loadModel(options: { fileName: string; contextLength: number }): Promise<void>;
  unloadModel(): Promise<void>;
  chatCompletion(options: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  }): Promise<{ text: string }>;
}
```

### Native implementation

- **Android:** Kotlin wrapper around llama.cpp's C++ library via JNI, adapted from llama.rn's Android module. Model files stored in app-internal storage.
- **iOS (future):** Swift wrapper using the same llama.cpp C library, adapted from llama.rn's iOS module.
- **Threading:** Inference runs on a dedicated background thread. The plugin signals completion back to JS via Capacitor's promise resolution.

## Model Selection

Ship with a curated list of recommended models linking to GGUF files on Hugging Face:

| Model | Size | Notes |
|-------|------|-------|
| **Gemma 4 E2B Q4_K_M** (default) | ~1.3 GB | Built for mobile, newest, smallest footprint |
| Gemma 4 E4B Q4_K_M | ~2.5 GB | Higher quality, still phone-friendly |
| Qwen 2.5 3B Q4_K_M | ~2 GB | Alternative option |

Gemma 4 E2B is the default recommendation — released April 3 2026, specifically optimized for on-device inference, Apache 2.0 licensed.

The model list is defined in code (not fetched remotely) and can be updated in app releases.

## Model Download UX

When the user selects "On-device (free)" in Settings and no model is downloaded:

1. Settings panel shows the model list with sizes and a "Download" button per model
2. Before downloading, check available disk space and warn if insufficient
3. Download shows a progress bar (percentage + MB downloaded / total)
4. Download can be cancelled mid-way (partial file is deleted)
5. Once downloaded, the model shows a checkmark and a "Delete" button
6. User can switch between downloaded models if they have more than one

All downloads happen within the app — the user never leaves to a browser or file manager.

## Provider Integration

### AiSettings changes

```typescript
interface AiSettings {
  provider: 'anthropic' | 'ollama' | 'gemini' | 'openai-compatible' | 'local';
  // ... existing fields ...
  localModel?: string; // filename of the selected downloaded model
}
```

### chatWithBook() changes

A new `case 'local'` branch in the existing switch:

1. Call the Capacitor plugin to load the model if not already loaded
2. Pass the system prompt + message history to `chatCompletion()`
3. Return the response text

### Analysis limitation

`analyzeChapterClient()` and `reconcileResultClient()` are **not modified**. When the provider is `'local'`, the app shows a note that analysis requires a cloud provider. Chat works locally; analysis does not.

### Settings UI

The provider grid in `SettingsModal` gains a fifth button: "On-device (free)". Only visible when `NEXT_PUBLIC_MOBILE === 'true'`.

When selected, the panel shows:
- Available models with download/delete controls
- Download progress during downloads
- Currently selected model
- Available disk space
- Note: "Chat only — book analysis requires a cloud provider"

## Chat Context Compression

The existing `buildChatSystemPrompt()` produces a rich context that may overwhelm a 2B model. A new `buildCompactChatSystemPrompt()` function produces a slimmer version:

- **Characters:** Main and secondary only (skip minor). Just name, status, and location — no relationship lists.
- **Narrative:** Overall book summary + most recent 5-8 chapter summaries (not all chapters).
- **Locations:** Top 10 most recently referenced only.
- **Anti-spoiler rules:** Same rules, more concise wording.
- **Target:** Keep the system prompt under ~1500 tokens.

Called when the provider is `'local'`; all other providers continue using the existing full prompt.

The ChatPanel shows a subtle note when using local: "Using on-device AI — responses may be simpler than cloud models."

## Model Lifecycle & Memory Management

### Load/unload strategy

- **Load:** On first chat message with the local provider. Not at app startup.
- **Unload:** When the user closes ChatPanel, switches books, switches providers, or after 5 minutes of chat inactivity.
- **Rationale:** Models use 1-2 GB of RAM when loaded. Don't hold that while the user browses characters or the map.

### Loading UX

First message has a cold-start delay (a few seconds on modern phones). Show "Loading AI model..." text before switching to the normal typing indicator once inference begins.

### Error handling

- **Model file corrupted/missing:** Prompt user to re-download.
- **Out of memory:** Catch the native error, suggest trying a smaller model (e.g., Gemma 4 E2B if they were using E4B).
- **Inference timeout:** If no tokens after 60 seconds, surface an error rather than hanging.

## Platform Support

- **Android:** First implementation target. Capacitor plugin built for Android.
- **iOS:** Architecture supports it (llama.rn has iOS bindings). Plugin's Swift side will be added when the iOS build is pursued.
- **Web:** The `'local'` provider option is hidden when `NEXT_PUBLIC_MOBILE !== 'true'`. The Capacitor plugin is not available in web builds.

## Files to Create or Modify

### New files
- `capacitor-llama/` — Capacitor plugin package (plugin definition, Android native code, TypeScript definitions)
- `lib/local-llm.ts` — Model manager (download orchestration, installed model tracking, load/unload lifecycle)

### Modified files
- `lib/ai-client.ts` — Add `'local'` to provider type, `localModel` to `AiSettings`, new case in `chatWithBook()`
- `lib/chat-context.ts` — Add `buildCompactChatSystemPrompt()` function
- `components/SettingsModal.tsx` — Add "On-device (free)" provider panel with model management UI
- `components/ChatPanel.tsx` — Use compact prompt when provider is local, show "on-device" note and loading state
- `types/index.ts` — Any new types needed for model metadata

## Out of Scope

- On-device book analysis (structured JSON output from small models is unreliable)
- Streaming token output (can be added later; initial version waits for full response)
- Custom model URLs (users can only pick from the curated list for now)
- iOS implementation (architecture supports it; Swift plugin code deferred)
