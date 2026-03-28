# Ollama Context Length Override

## Problem

When users configure a custom `num_ctx` in the Ollama app (e.g., 16K for VRAM management), BookBuddy ignores it. The app queries Ollama's `/api/show` endpoint, which returns the model's default metadata (e.g., 32768 for qwen2.5:32b) rather than the runtime override. This causes a mismatch: the app budgets text for 32K, but Ollama is running at 16K, risking truncation or failed inference.

Users need the app's chunk budgeting to match their actual Ollama context window so processing is aligned and accurate.

## Scope

Ollama provider only. Cloud providers (Anthropic, Gemini, OpenAI-compatible) have fixed, reliably-detected context windows and are not affected.

## Design

### UI: Context Length Slider in SettingsModal

In the Ollama section of SettingsModal, below the model name field:

- **Label:** "Context Length (tokens)"
- **Control:** Slider with a numeric input beside it for precise entry
- **Range:** 2048 to 131072 (step: 1024)
- **Default state:** Auto-detect via `/api/show` on load or model change. Show "Auto-detected: {value}" label.
- **User override:** Moving the slider or typing a value persists in localStorage as part of `cc-ai-settings`.
- **Reset:** A "Reset to detected" link/button that re-queries `/api/show` and resets the slider.

The slider value replaces the auto-detected value for all chunk budgeting.

### Data Flow

- **Storage:** `ollamaContextLength` (user override) and `ollamaDetectedContextLength` (what `/api/show` returned) in `localStorage['cc-ai-settings']`.
- **Server path (`/api/analyze`):** Client sends `contextLength` as an optional field in the request body. When present, `context-window.ts` skips the `/api/show` query and uses this value directly.
- **Client path (`ai-client.ts` for mobile):** Reads `ollamaContextLength` from localStorage. Same logic — if set, use it instead of querying `/api/show`.
- **Terminal logging:** Indicate source: "Context window: 16384 (user override)" vs "Context window: 32768 (auto-detected)".

### Auto-Detection Trigger & Model Change Behavior

- **On "Test Connection" click:** After a successful test, query `/api/show` and update `ollamaDetectedContextLength`. If the user has a manual override, keep their value but update the "Auto-detected: X" label so they can see any mismatch.
- **On model name change:** Reset the slider to auto-detect for the new model. The old override no longer applies.
- **Detection failure:** If `/api/show` fails, show the slider at 4096 (existing fallback) with a note: "Could not detect — using default 4096. Adjust to match your Ollama setting."

### Edge Cases

- **Value higher than model default:** Allowed. Some users intentionally push `num_ctx` beyond defaults.
- **Value at minimum (2048):** Allowed. Chunk splitting handles small budgets by producing more sub-chunks. Slower but correct.
- **Value not set / cleared:** Falls back to auto-detection. No breaking change for existing users.
- **Mobile/APK:** `ai-client.ts` reads the same localStorage setting. No special handling needed.
- **Multiple browser tabs:** localStorage is shared per origin. Change in one tab is picked up on next analysis in another.

## Files to Modify

| File | Change |
|------|--------|
| `components/SettingsModal.tsx` | Add context length slider + numeric input + reset button in Ollama section |
| `lib/context-window.ts` | Accept optional `contextLength` override; skip `/api/show` when provided; update logging |
| `lib/ai-client.ts` | Read `ollamaContextLength` from settings; pass to context window logic |
| `app/api/analyze/route.ts` | Accept `contextLength` from request body; pass through to context window detection |
| Any other API routes calling `getContextWindowSize()` | Pass through `contextLength` if present in request |
