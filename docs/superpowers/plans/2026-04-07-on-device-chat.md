# On-Device AI Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable free, offline AI chat on mobile by running a small LLM (Gemma 4 E2B) directly on the phone via llama.cpp.

**Architecture:** A Capacitor local plugin wraps llama.cpp via JNI on Android. The TypeScript layer adds a `'local'` provider to the existing AI settings system, reusing the `ChatPanel` component with a compact context builder optimized for small models. Model files (~1.3 GB GGUF) are downloaded in-app and stored in app-private storage.

**Tech Stack:** llama.cpp (C/C++), Capacitor 6 local plugin, Kotlin (Android native), JNI, TypeScript/React

**Spec:** `docs/superpowers/specs/2026-04-07-on-device-chat-design.md`

---

### Task 1: Compact Chat Context Builder

**Files:**
- Modify: `lib/chat-context.ts`

This task adds a slimmer version of the chat system prompt that stays under ~1500 tokens so small on-device models have room to respond.

- [ ] **Step 1: Add `buildCompactChatSystemPrompt()` to `lib/chat-context.ts`**

Append this function after the existing `buildChatSystemPrompt()`:

```typescript
/**
 * Builds a compact system prompt for on-device (local) models.
 * Keeps total prompt under ~1500 tokens by trimming characters,
 * limiting narrative history, and using shorter instructions.
 */
export function buildCompactChatSystemPrompt(
  bookTitle: string,
  bookAuthor: string,
  lastAnalyzedIndex: number,
  currentChapterTitle: string,
  totalChapters: number,
  result: AnalysisResult,
  snapshots: Snapshot[],
  chapterTitles: string[],
): string {
  const chaptersRead = lastAnalyzedIndex + 1;

  // Overall summary + recent chapter narrative (last 8 chapters max)
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  const recentSnapshots = sorted.filter((s) => s.result.summary).slice(-8);
  const chapterNarrative = recentSnapshots
    .map((s) => {
      const title = chapterTitles[s.index] ?? `Chapter ${s.index + 1}`;
      return `[${title}]: ${s.result.summary}`;
    })
    .join('\n');

  const narrativeParts: string[] = [];
  if (result.summary) narrativeParts.push(`OVERALL: ${result.summary}`);
  if (chapterNarrative) narrativeParts.push(chapterNarrative);
  const narrative = narrativeParts.join('\n\n') || '(No summaries yet.)';

  // Main and secondary characters only, minimal info
  const chars = result.characters
    .filter((c) => c.importance !== 'minor')
    .map((c) => {
      const loc = c.currentLocation && c.currentLocation !== 'Unknown' ? ` at ${c.currentLocation}` : '';
      return `• ${c.name} (${c.status}${loc})`;
    })
    .join('\n');

  // Top 10 locations only
  const locs = (result.locations ?? [])
    .slice(0, 10)
    .map((l) => `• ${l.name}: ${l.description.split('.')[0]}`)
    .join('\n');

  return `You are a spoiler-free reading companion for "${bookTitle}" by ${bookAuthor}.
Reader has read ${chaptersRead}/${totalChapters} chapters, through "${currentChapterTitle}".

RULES:
- Only discuss chapters 1–${chaptersRead}. Never reveal anything after.
- If you recognise this book, ignore outside knowledge.
- If unsure whether something is a spoiler, don't say it.

RECENT STORY:
${narrative}

CHARACTERS:
${chars || '(None tracked.)'}
${locs ? `\nLOCATIONS:\n${locs}` : ''}

Answer conversationally about what the reader has already read.`.trim();
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds with no type errors in `chat-context.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/chat-context.ts
git commit -m "feat: add compact chat system prompt for on-device models"
```

---

### Task 2: AiSettings Type Update + Plugin TypeScript Layer

**Files:**
- Modify: `lib/ai-client.ts` (AiSettings type and loadAiSettings/saveAiSettings)
- Create: `lib/llama-plugin.ts` (Capacitor plugin interface and registration)
- Create: `lib/local-llm.ts` (model manager — download, list, delete, load, unload, chat)

- [ ] **Step 1: Update `AiSettings` in `lib/ai-client.ts`**

Add `'local'` to the provider union and `localModel` field:

```typescript
// In the AiSettings interface, change:
export interface AiSettings {
  provider: 'anthropic' | 'ollama' | 'gemini' | 'openai-compatible' | 'local';
  anthropicKey: string;
  ollamaUrl: string;
  model: string;
  geminiKey: string;
  openaiCompatibleUrl: string;
  openaiCompatibleKey: string;
  openaiCompatibleName: string;
  ollamaContextLength?: number;
  ollamaDetectedContextLength?: number;
  localModel?: string;  // filename of the selected downloaded GGUF
}
```

In `loadAiSettings()`, add `localModel` to the return objects:

```typescript
// In the parsed branch, add:
localModel: parsed.localModel ?? undefined,

// In the default return, add:
localModel: undefined,
```

- [ ] **Step 2: Create `lib/llama-plugin.ts`**

```typescript
/**
 * Capacitor plugin interface for on-device llama.cpp inference.
 * The native implementation lives in the Android project at:
 *   android/app/src/main/java/com/chaptercompanion/app/LlamaPlugin.kt
 */

import { registerPlugin } from '@capacitor/core';
import type { Plugin } from '@capacitor/core';

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
}

export interface ModelInfo {
  fileName: string;
  sizeBytes: number;
}

export interface LlamaPluginInterface extends Plugin {
  downloadModel(options: { url: string; fileName: string }): Promise<void>;
  cancelDownload(): Promise<void>;
  deleteModel(options: { fileName: string }): Promise<void>;
  listModels(): Promise<{ models: ModelInfo[] }>;
  getFreeDiskSpace(): Promise<{ bytes: number }>;
  loadModel(options: { fileName: string; contextLength: number }): Promise<void>;
  unloadModel(): Promise<void>;
  isModelLoaded(): Promise<{ loaded: boolean; fileName: string | null }>;
  chatCompletion(options: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  }): Promise<{ text: string }>;
}

export const LlamaPlugin = registerPlugin<LlamaPluginInterface>('LlamaPlugin');
```

- [ ] **Step 3: Create `lib/local-llm.ts`**

```typescript
/**
 * Model manager for on-device LLM inference.
 * Wraps the LlamaPlugin Capacitor plugin with lifecycle management:
 * download progress, load/unload on demand, idle timeout.
 */

import { LlamaPlugin } from './llama-plugin';
import type { ModelInfo, DownloadProgress } from './llama-plugin';
import type { PluginListenerHandle } from '@capacitor/core';

// Curated model list — update in app releases
export interface ModelEntry {
  id: string;
  name: string;
  fileName: string;
  url: string;
  sizeBytes: number;     // approximate download size
  sizeLabel: string;     // human-readable, e.g. "1.3 GB"
  contextLength: number; // default context window for this model
  description: string;
}

export const AVAILABLE_MODELS: ModelEntry[] = [
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    fileName: 'gemma-4-E2B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf',
    sizeBytes: 1_395_864_576,
    sizeLabel: '1.3 GB',
    contextLength: 8192,
    description: 'Best balance — built for mobile, fast and small',
  },
  {
    id: 'gemma-4-e4b',
    name: 'Gemma 4 E4B',
    fileName: 'gemma-4-E4B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf',
    sizeBytes: 2_684_354_560,
    sizeLabel: '2.5 GB',
    contextLength: 8192,
    description: 'Higher quality, needs more RAM',
  },
  {
    id: 'qwen-2.5-3b',
    name: 'Qwen 2.5 3B',
    fileName: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeBytes: 2_147_483_648,
    sizeLabel: '2.0 GB',
    contextLength: 32768,
    description: 'Alternative option with large context window',
  },
];

// ---------------------------------------------------------------------------
// Download management
// ---------------------------------------------------------------------------

let downloadListener: PluginListenerHandle | null = null;

export async function downloadModel(
  entry: ModelEntry,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  // Clean up any prior listener
  downloadListener?.remove();
  downloadListener = await LlamaPlugin.addListener('downloadProgress', onProgress);
  try {
    await LlamaPlugin.downloadModel({ url: entry.url, fileName: entry.fileName });
  } finally {
    downloadListener.remove();
    downloadListener = null;
  }
}

export async function cancelDownload(): Promise<void> {
  await LlamaPlugin.cancelDownload();
  downloadListener?.remove();
  downloadListener = null;
}

export async function deleteModel(fileName: string): Promise<void> {
  // Unload first if this model is currently loaded
  const { loaded, fileName: loadedFile } = await LlamaPlugin.isModelLoaded();
  if (loaded && loadedFile === fileName) {
    await unloadModel();
  }
  await LlamaPlugin.deleteModel({ fileName });
}

export async function listModels(): Promise<ModelInfo[]> {
  const { models } = await LlamaPlugin.listModels();
  return models;
}

export async function getFreeDiskSpace(): Promise<number> {
  const { bytes } = await LlamaPlugin.getFreeDiskSpace();
  return bytes;
}

// ---------------------------------------------------------------------------
// Inference lifecycle
// ---------------------------------------------------------------------------

let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    LlamaPlugin.unloadModel().catch(() => {});
    idleTimer = null;
  }, IDLE_TIMEOUT_MS);
}

export async function ensureModelLoaded(fileName: string, contextLength: number): Promise<void> {
  const { loaded, fileName: loadedFile } = await LlamaPlugin.isModelLoaded();
  if (loaded && loadedFile === fileName) {
    resetIdleTimer();
    return;
  }
  if (loaded) {
    await LlamaPlugin.unloadModel();
  }
  await LlamaPlugin.loadModel({ fileName, contextLength });
  resetIdleTimer();
}

export async function unloadModel(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  await LlamaPlugin.unloadModel();
}

const INFERENCE_TIMEOUT_MS = 60_000; // 60 seconds

export async function chatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string> {
  resetIdleTimer();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('On-device inference timed out after 60 seconds. Try a shorter question or a smaller model.')), INFERENCE_TIMEOUT_MS),
  );
  const { text } = await Promise.race([LlamaPlugin.chatCompletion({ messages }), timeout]);
  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findModelEntry(fileName: string): ModelEntry | undefined {
  return AVAILABLE_MODELS.find((m) => m.fileName === fileName);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
```

- [ ] **Step 4: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds. The `registerPlugin` call will be a no-op on web (plugin not found), which is fine — the local provider is hidden in web builds.

- [ ] **Step 5: Commit**

```bash
git add lib/ai-client.ts lib/llama-plugin.ts lib/local-llm.ts
git commit -m "feat: add local LLM TypeScript layer — plugin interface + model manager"
```

---

### Task 3: Android Native — Build Setup and llama.cpp Integration

**Files:**
- Modify: `android/app/build.gradle` (add CMake + NDK config)
- Modify: `android/variables.gradle` (bump minSdk to 24)
- Create: `android/app/src/main/cpp/CMakeLists.txt`
- Create: `android/app/src/main/cpp/llama-jni.cpp` (JNI bridge)

This task sets up the native build infrastructure. llama.cpp is included as source via a git submodule and compiled as part of the Android build via CMake.

- [ ] **Step 1: Add llama.cpp as a git submodule**

```bash
git submodule add https://github.com/ggml-org/llama.cpp.git android/app/src/main/cpp/llama.cpp
```

- [ ] **Step 2: Bump `minSdkVersion` to 24 in `android/variables.gradle`**

Change line 2:

```groovy
minSdkVersion = 24
```

llama.cpp's Android build requires API 24+ for full C++17 threading support.

- [ ] **Step 3: Add CMake and NDK configuration to `android/app/build.gradle`**

Add inside the `android { }` block, after the `buildTypes` section:

```groovy
    ndkVersion '26.1.10909125'

    externalNativeBuild {
        cmake {
            path 'src/main/cpp/CMakeLists.txt'
        }
    }

    defaultConfig {
        // (add inside existing defaultConfig block)
        ndk {
            abiFilters 'arm64-v8a', 'armeabi-v7a'
        }
        externalNativeBuild {
            cmake {
                arguments '-DANDROID_STL=c++_shared'
                cppFlags '-std=c++17'
            }
        }
    }
```

Note: the `ndk { abiFilters }` and `externalNativeBuild { cmake }` directives go inside the existing `defaultConfig` block. The `ndkVersion` and top-level `externalNativeBuild` go directly inside `android { }`.

- [ ] **Step 4: Create `android/app/src/main/cpp/CMakeLists.txt`**

```cmake
cmake_minimum_required(VERSION 3.22)
project(llama-jni)

set(CMAKE_CXX_STANDARD 17)

# llama.cpp source (git submodule)
set(LLAMA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp)

# Build llama.cpp as a static library
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
set(GGML_CUDA OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

add_subdirectory(${LLAMA_DIR} llama.cpp)

# JNI bridge
add_library(llama-jni SHARED llama-jni.cpp)

target_include_directories(llama-jni PRIVATE
    ${LLAMA_DIR}/include
    ${LLAMA_DIR}/common
)

target_link_libraries(llama-jni
    llama
    common
    log
    android
)
```

- [ ] **Step 5: Create a minimal `android/app/src/main/cpp/llama-jni.cpp`**

Start with a build-verification stub. The full implementation comes in Task 4.

```cpp
#include <jni.h>
#include <string>
#include "llama.h"

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeVersion(JNIEnv *env, jobject /* this */) {
    return env->NewStringUTF("llama.cpp linked OK");
}

} // extern "C"
```

- [ ] **Step 6: Verify the Android project builds**

```bash
cd android && ./gradlew assembleDebug
```

Expected: Build succeeds, llama.cpp compiles, `libllama-jni.so` is produced in the APK.

- [ ] **Step 7: Commit**

```bash
git add android/app/build.gradle android/variables.gradle android/app/src/main/cpp/
git commit -m "feat: add llama.cpp native build infrastructure for Android"
```

---

### Task 4: Android Native — JNI Bridge

**Files:**
- Replace: `android/app/src/main/cpp/llama-jni.cpp` (full JNI implementation)

This replaces the stub from Task 3 with the complete JNI bridge that manages model loading, context creation, and chat inference.

- [ ] **Step 1: Write the full `android/app/src/main/cpp/llama-jni.cpp`**

```cpp
#include <jni.h>
#include <android/log.h>
#include <string>
#include <vector>
#include <mutex>
#include <thread>
#include "llama.h"
#include "common.h"

#define TAG "LlamaJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static llama_model * g_model = nullptr;
static llama_context * g_ctx = nullptr;
static std::string g_loaded_path;
static std::mutex g_mutex;

extern "C" {

// -----------------------------------------------------------------------
// Load / unload
// -----------------------------------------------------------------------

JNIEXPORT jboolean JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeLoadModel(
    JNIEnv *env, jobject, jstring jpath, jint contextLength
) {
    std::lock_guard<std::mutex> lock(g_mutex);

    const char *path = env->GetStringUTFChars(jpath, nullptr);
    std::string pathStr(path);
    env->ReleaseStringUTFChars(jpath, path);

    // Already loaded?
    if (g_model && g_loaded_path == pathStr) {
        LOGI("Model already loaded: %s", pathStr.c_str());
        return JNI_TRUE;
    }

    // Unload any previous model
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_loaded_path.clear();

    // Load model
    llama_model_params mparams = llama_model_default_params();
    g_model = llama_model_load_from_file(pathStr.c_str(), mparams);
    if (!g_model) {
        LOGE("Failed to load model: %s", pathStr.c_str());
        return JNI_FALSE;
    }

    // Create context
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = contextLength > 0 ? contextLength : 8192;
    cparams.n_batch = 512;
    cparams.n_threads = std::max(1, (int)std::thread::hardware_concurrency() - 1);

    g_ctx = llama_init_from_model(g_model, cparams);
    if (!g_ctx) {
        LOGE("Failed to create context");
        llama_model_free(g_model);
        g_model = nullptr;
        return JNI_FALSE;
    }

    g_loaded_path = pathStr;
    LOGI("Model loaded: %s (ctx=%d, threads=%d)", pathStr.c_str(),
         cparams.n_ctx, cparams.n_threads);
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeUnloadModel(JNIEnv *, jobject) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_ctx) { llama_free(g_ctx); g_ctx = nullptr; }
    if (g_model) { llama_model_free(g_model); g_model = nullptr; }
    g_loaded_path.clear();
    LOGI("Model unloaded");
}

JNIEXPORT jboolean JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeIsLoaded(JNIEnv *, jobject) {
    return g_model != nullptr && g_ctx != nullptr ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeGetLoadedPath(JNIEnv *env, jobject) {
    return env->NewStringUTF(g_loaded_path.c_str());
}

// -----------------------------------------------------------------------
// Chat completion
// -----------------------------------------------------------------------

JNIEXPORT jstring JNICALL
Java_com_chaptercompanion_app_LlamaBridge_nativeChatCompletion(
    JNIEnv *env, jobject,
    jobjectArray jroles, jobjectArray jcontents
) {
    std::lock_guard<std::mutex> lock(g_mutex);

    if (!g_model || !g_ctx) {
        return env->NewStringUTF("[error] No model loaded");
    }

    // Build messages vector
    int msgCount = env->GetArrayLength(jroles);
    std::vector<llama_chat_msg> messages;
    std::vector<std::string> roleStrs, contentStrs; // keep alive for pointers

    for (int i = 0; i < msgCount; i++) {
        auto jrole = (jstring)env->GetObjectArrayElement(jroles, i);
        auto jcontent = (jstring)env->GetObjectArrayElement(jcontents, i);
        const char *role = env->GetStringUTFChars(jrole, nullptr);
        const char *content = env->GetStringUTFChars(jcontent, nullptr);
        roleStrs.emplace_back(role);
        contentStrs.emplace_back(content);
        env->ReleaseStringUTFChars(jrole, role);
        env->ReleaseStringUTFChars(jcontent, content);
    }

    for (int i = 0; i < msgCount; i++) {
        messages.push_back({roleStrs[i].c_str(), contentStrs[i].c_str()});
    }

    // Apply chat template to get the formatted prompt
    const llama_model * model = g_model;
    std::vector<char> buf(4096);
    int len = llama_chat_apply_template(
        llama_model_chat_template(model, nullptr),
        messages.data(), messages.size(),
        true, buf.data(), buf.size()
    );
    if (len < 0) {
        return env->NewStringUTF("[error] Failed to apply chat template");
    }
    if (len > (int)buf.size()) {
        buf.resize(len + 1);
        llama_chat_apply_template(
            llama_model_chat_template(model, nullptr),
            messages.data(), messages.size(),
            true, buf.data(), buf.size()
        );
    }
    std::string prompt(buf.data(), len);

    // Tokenize
    int n_ctx = llama_n_ctx(g_ctx);
    std::vector<llama_token> tokens(n_ctx);
    int n_tokens = llama_tokenize(
        llama_model_get_model(g_ctx) ? g_model : g_model,
        prompt.c_str(), prompt.size(),
        tokens.data(), tokens.size(),
        true, true
    );
    if (n_tokens < 0) {
        return env->NewStringUTF("[error] Tokenization failed — prompt may be too long");
    }
    tokens.resize(n_tokens);

    // Clear KV cache for new conversation
    llama_kv_cache_clear(g_ctx);

    // Decode prompt tokens
    llama_batch batch = llama_batch_init(512, 0, 1);
    for (int i = 0; i < n_tokens; i++) {
        llama_batch_add(batch, tokens[i], i, {0}, (i == n_tokens - 1));
    }
    if (llama_decode(g_ctx, batch) != 0) {
        llama_batch_free(batch);
        return env->NewStringUTF("[error] Decode failed");
    }
    llama_batch_free(batch);

    // Sample tokens
    llama_sampler * sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.7f));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.9f, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(42));

    std::string result;
    int max_tokens = 1024;
    int pos = n_tokens;

    for (int i = 0; i < max_tokens; i++) {
        llama_token new_token = llama_sampler_sample(sampler, g_ctx, -1);

        // EOS check
        if (llama_vocab_is_eog(llama_model_get_vocab(g_model), new_token)) {
            break;
        }

        // Convert token to text
        char piece[128];
        int n = llama_token_to_piece(llama_model_get_vocab(g_model), new_token, piece, sizeof(piece), 0, true);
        if (n > 0) {
            result.append(piece, n);
        }

        // Prepare next batch
        batch = llama_batch_init(1, 0, 1);
        llama_batch_add(batch, new_token, pos++, {0}, true);
        if (llama_decode(g_ctx, batch) != 0) {
            llama_batch_free(batch);
            break;
        }
        llama_batch_free(batch);
    }

    llama_sampler_free(sampler);

    return env->NewStringUTF(result.c_str());
}

} // extern "C"
```

**Note:** The llama.cpp API evolves frequently. If function signatures have changed from what's shown above, consult `llama.cpp/include/llama.h` in the submodule for the current API. The structure and flow (load → template → tokenize → decode → sample) remains the same.

- [ ] **Step 2: Verify the Android project builds**

```bash
cd android && ./gradlew assembleDebug
```

Expected: Builds successfully. JNI functions compile against the llama.cpp headers.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/cpp/llama-jni.cpp
git commit -m "feat: implement JNI bridge for llama.cpp model loading and chat inference"
```

---

### Task 5: Android Native — Capacitor Plugin (Kotlin)

**Files:**
- Create: `android/app/src/main/java/com/chaptercompanion/app/LlamaBridge.kt` (JNI declarations)
- Create: `android/app/src/main/java/com/chaptercompanion/app/LlamaPlugin.kt` (Capacitor plugin)
- Modify: `android/app/src/main/java/com/chaptercompanion/app/MainActivity.java` (register plugin)

- [ ] **Step 1: Create `LlamaBridge.kt`**

This declares the native JNI methods and provides the model storage directory.

```kotlin
package com.chaptercompanion.app

import android.content.Context

class LlamaBridge(private val context: Context) {
    companion object {
        init {
            System.loadLibrary("llama-jni")
        }
    }

    fun modelsDir(): java.io.File {
        val dir = java.io.File(context.filesDir, "llama-models")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    fun modelPath(fileName: String): String {
        return java.io.File(modelsDir(), fileName).absolutePath
    }

    // JNI methods — implemented in llama-jni.cpp
    external fun nativeLoadModel(path: String, contextLength: Int): Boolean
    external fun nativeUnloadModel()
    external fun nativeIsLoaded(): Boolean
    external fun nativeGetLoadedPath(): String
    external fun nativeChatCompletion(roles: Array<String>, contents: Array<String>): String
}
```

- [ ] **Step 2: Create `LlamaPlugin.kt`**

```kotlin
package com.chaptercompanion.app

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.*

@CapacitorPlugin(name = "LlamaPlugin")
class LlamaPlugin : Plugin() {
    private lateinit var bridge: LlamaBridge
    private var downloadJob: Job? = null

    override fun load() {
        bridge = LlamaBridge(context)
    }

    // -----------------------------------------------------------------------
    // Model management
    // -----------------------------------------------------------------------

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val urlStr = call.getString("url") ?: return call.reject("Missing url")
        val fileName = call.getString("fileName") ?: return call.reject("Missing fileName")
        val dest = File(bridge.modelsDir(), fileName)
        val tempDest = File(bridge.modelsDir(), "$fileName.part")

        downloadJob = CoroutineScope(Dispatchers.IO).launch {
            try {
                val url = URL(urlStr)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.connect()

                if (conn.responseCode != 200) {
                    call.reject("Download failed: HTTP ${conn.responseCode}")
                    return@launch
                }

                val totalBytes = conn.contentLengthLong
                var bytesDownloaded = 0L
                val buffer = ByteArray(8192)

                conn.inputStream.use { input ->
                    FileOutputStream(tempDest).use { output ->
                        while (isActive) {
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            bytesDownloaded += read

                            // Emit progress every ~100KB
                            if (bytesDownloaded % (100 * 1024) < 8192) {
                                val progress = JSObject()
                                progress.put("bytesDownloaded", bytesDownloaded)
                                progress.put("totalBytes", totalBytes)
                                notifyListeners("downloadProgress", progress)
                            }
                        }
                    }
                }

                if (!isActive) {
                    tempDest.delete()
                    call.reject("Download cancelled")
                    return@launch
                }

                tempDest.renameTo(dest)
                call.resolve()
            } catch (e: Exception) {
                tempDest.delete()
                call.reject("Download failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        downloadJob?.cancel()
        downloadJob = null
        call.resolve()
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val fileName = call.getString("fileName") ?: return call.reject("Missing fileName")
        val file = File(bridge.modelsDir(), fileName)
        if (file.exists()) file.delete()
        call.resolve()
    }

    @PluginMethod
    fun listModels(call: PluginCall) {
        val dir = bridge.modelsDir()
        val models = JSONArray()
        dir.listFiles()?.filter { it.extension == "gguf" }?.forEach { file ->
            val model = JSObject()
            model.put("fileName", file.name)
            model.put("sizeBytes", file.length())
            models.put(model)
        }
        val result = JSObject()
        result.put("models", models)
        call.resolve(result)
    }

    @PluginMethod
    fun getFreeDiskSpace(call: PluginCall) {
        val result = JSObject()
        result.put("bytes", bridge.modelsDir().usableSpace)
        call.resolve(result)
    }

    // -----------------------------------------------------------------------
    // Inference
    // -----------------------------------------------------------------------

    @PluginMethod
    fun loadModel(call: PluginCall) {
        val fileName = call.getString("fileName") ?: return call.reject("Missing fileName")
        val contextLength = call.getInt("contextLength") ?: 8192
        val path = bridge.modelPath(fileName)

        if (!File(path).exists()) {
            return call.reject("Model file not found: $fileName")
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val ok = bridge.nativeLoadModel(path, contextLength)
                if (ok) call.resolve() else call.reject("Failed to load model — possibly not enough RAM")
            } catch (e: Exception) {
                call.reject("Load failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun unloadModel(call: PluginCall) {
        bridge.nativeUnloadModel()
        call.resolve()
    }

    @PluginMethod
    fun isModelLoaded(call: PluginCall) {
        val loaded = bridge.nativeIsLoaded()
        val loadedPath = bridge.nativeGetLoadedPath()
        val result = JSObject()
        result.put("loaded", loaded)
        // Extract just the filename from the full path
        val fileName = if (loadedPath.isNotEmpty()) File(loadedPath).name else null
        result.put("fileName", fileName)
        call.resolve(result)
    }

    @PluginMethod
    fun chatCompletion(call: PluginCall) {
        val messagesArray = call.getArray("messages") ?: return call.reject("Missing messages")

        val roles = mutableListOf<String>()
        val contents = mutableListOf<String>()

        for (i in 0 until messagesArray.length()) {
            val msg = messagesArray.getJSONObject(i)
            roles.add(msg.getString("role"))
            contents.add(msg.getString("content"))
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = bridge.nativeChatCompletion(
                    roles.toTypedArray(),
                    contents.toTypedArray()
                )
                val response = JSObject()
                response.put("text", result)
                call.resolve(response)
            } catch (e: Exception) {
                call.reject("Inference failed: ${e.message}")
            }
        }
    }
}
```

- [ ] **Step 3: Register plugin in `MainActivity.java`**

Replace the contents of `android/app/src/main/java/com/chaptercompanion/app/MainActivity.java`:

```java
package com.chaptercompanion.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(LlamaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

- [ ] **Step 4: Add Kotlin and coroutines support to `android/app/build.gradle`**

At the top of `android/app/build.gradle`, add Kotlin plugin:

```groovy
apply plugin: 'com.android.application'
apply plugin: 'kotlin-android'
```

In the `dependencies` block, add:

```groovy
implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3"
```

In `android/build.gradle` (project-level), ensure the Kotlin plugin classpath is available. Add inside the `buildscript { dependencies { } }` block if it exists, or add the block:

```groovy
buildscript {
    dependencies {
        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.22'
    }
}
```

- [ ] **Step 5: Verify the Android project builds**

```bash
cd android && ./gradlew assembleDebug
```

Expected: Builds successfully. The LlamaPlugin is registered and callable from the WebView.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/chaptercompanion/app/
git add android/app/build.gradle android/build.gradle
git commit -m "feat: add LlamaPlugin Capacitor plugin — model management and inference"
```

---

### Task 6: Provider Integration in `chatWithBook()`

**Files:**
- Modify: `lib/ai-client.ts`
- Modify: `components/ChatPanel.tsx`

- [ ] **Step 1: Add `case 'local'` to `chatWithBook()` in `lib/ai-client.ts`**

Add a new case before the `default:` (ollama) case in the `chatWithBook()` switch statement, around line 307:

```typescript
    case 'local': {
      const { ensureModelLoaded, chatCompletion, findModelEntry } = await import('./local-llm');
      if (!settings.localModel) throw new Error('No local model selected. Open Settings to download one.');
      const entry = findModelEntry(settings.localModel);
      const ctxLen = entry?.contextLength ?? 8192;
      await ensureModelLoaded(settings.localModel, ctxLen);
      const chatMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...messages,
      ];
      return chatCompletion(chatMessages);
    }
```

- [ ] **Step 2: Update `ChatPanel.tsx` to use compact prompt for local provider**

In `components/ChatPanel.tsx`, update the import and the `sendChat` function.

Add import at the top:

```typescript
import { buildChatSystemPrompt, buildCompactChatSystemPrompt } from '@/lib/chat-context';
```

Remove the existing single import of `buildChatSystemPrompt`.

Then update the `systemPrompt` computation inside the component (around line 77) to choose based on provider:

```typescript
  // Determine if local provider for compact prompt
  const [isLocalProvider, setIsLocalProvider] = useState(false);
  useEffect(() => {
    if (IS_MOBILE) {
      import('@/lib/ai-client').then(({ loadAiSettings }) => {
        setIsLocalProvider(loadAiSettings().provider === 'local');
      });
    }
  }, []);

  const systemPrompt = (isLocalProvider ? buildCompactChatSystemPrompt : buildChatSystemPrompt)(
    bookTitle, bookAuthor, lastAnalyzedIndex, currentChapterTitle,
    totalChapters, result, snapshots, chapterTitles,
  );
```

- [ ] **Step 3: Add loading state text for model loading**

In `ChatPanel.tsx`, update the loading indicator (around line 188) to show model loading text:

Replace the existing loading block:

```typescript
          {loading && (
            <div className="flex justify-start">
              <div className="bg-stone-100 dark:bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
```

With:

```typescript
          {loading && (
            <div className="flex justify-start">
              <div className="bg-stone-100 dark:bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-3">
                {isLocalProvider && messages.length <= 1 && (
                  <p className="text-[10px] text-stone-400 dark:text-zinc-500 mb-1">Loading AI model...</p>
                )}
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 4: Add on-device quality note to the header**

In the header subtitle line (around line 131), update it to show an on-device indicator:

```typescript
            <p className="text-xs text-stone-400 dark:text-zinc-500 truncate">
              {isLocalProvider ? 'On-device AI · ' : 'Spoiler-free · '}knows ch. 1–{chaptersRead} of {totalChapters}
            </p>
```

- [ ] **Step 5: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.ts components/ChatPanel.tsx
git commit -m "feat: integrate local provider into chatWithBook and ChatPanel"
```

---

### Task 7: Settings UI — On-Device Provider Panel

**Files:**
- Modify: `components/SettingsModal.tsx`

This adds the "On-device (free)" provider option and model management UI to the existing settings modal.

- [ ] **Step 1: Add imports and state for local model management**

At the top of `SettingsModal.tsx`, add imports:

```typescript
import type { ModelInfo } from '@/lib/llama-plugin';
import type { ModelEntry, DownloadProgress } from '@/lib/local-llm';
```

Inside the `SettingsModal` component, add state variables after the existing state declarations:

```typescript
  const [localModels, setLocalModels] = useState<ModelInfo[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null); // fileName
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [freeSpace, setFreeSpace] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
```

- [ ] **Step 2: Add effect to load local model state when provider is 'local'**

```typescript
  useEffect(() => {
    if (settings.provider !== 'local') return;
    let cancelled = false;
    (async () => {
      try {
        const { listModels, getFreeDiskSpace, AVAILABLE_MODELS } = await import('@/lib/local-llm');
        const models = await listModels();
        const space = await getFreeDiskSpace();
        if (!cancelled) {
          setLocalModels(models);
          setAvailableModels(AVAILABLE_MODELS);
          setFreeSpace(space);
        }
      } catch { /* plugin not available in web */ }
    })();
    return () => { cancelled = true; };
  }, [settings.provider]);
```

- [ ] **Step 3: Add the "On-device (free)" provider button**

In the provider grid (around line 126), add the local option. It should only render on mobile builds. Add this entry to the array of providers, inside a conditional:

After the existing provider buttons array, wrap the grid to conditionally include the local option:

```typescript
          {([
              { value: 'ollama' as const, label: 'Ollama (local)' },
              { value: 'anthropic' as const, label: 'Anthropic' },
              { value: 'gemini' as const, label: 'Gemini (free)' },
              { value: 'openai-compatible' as const, label: settings.openaiCompatibleName || 'OpenAI-compat' },
              ...(IS_MOBILE ? [{ value: 'local' as const, label: 'On-device (free)' }] : []),
            ] as const).map((opt) => (
```

Add the `IS_MOBILE` constant near the top of the file if not already present:

```typescript
const IS_MOBILE = process.env.NEXT_PUBLIC_MOBILE === 'true';
```

Update the grid from `grid-cols-2` to handle 5 items when mobile:

```typescript
          <div className={`grid gap-1 rounded-lg border border-stone-300 dark:border-zinc-700 p-1 ${IS_MOBILE ? 'grid-cols-3' : 'grid-cols-2'}`}>
```

- [ ] **Step 4: Add the local provider config panel**

After the OpenAI-compatible config block (around line 448) and before the test connection section, add:

```typescript
        {/* Local (on-device) config */}
        {settings.provider === 'local' && (
          <div className="space-y-3">
            {freeSpace !== null && (
              <p className="text-[10px] text-stone-400 dark:text-zinc-600">
                Free space: {freeSpace > 1024 * 1024 * 1024
                  ? `${(freeSpace / (1024 * 1024 * 1024)).toFixed(1)} GB`
                  : `${(freeSpace / (1024 * 1024)).toFixed(0)} MB`}
              </p>
            )}

            <div className="space-y-2">
              {availableModels.map((entry) => {
                const installed = localModels.find((m) => m.fileName === entry.fileName);
                const isDownloading = downloading === entry.fileName;
                const isSelected = settings.localModel === entry.fileName;

                return (
                  <div
                    key={entry.id}
                    className={`rounded-lg border p-3 transition-colors ${
                      isSelected
                        ? 'border-amber-500/50 bg-amber-500/10'
                        : 'border-stone-300 dark:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{entry.name}</p>
                        <p className="text-[10px] text-stone-400 dark:text-zinc-500">
                          {entry.sizeLabel} · {entry.description}
                        </p>
                      </div>
                      <div className="flex gap-1.5 flex-shrink-0">
                        {installed ? (
                          <>
                            {!isSelected && (
                              <button
                                onClick={() => set('localModel', entry.fileName)}
                                className="px-2 py-1 text-[10px] rounded border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:border-amber-500/50 hover:text-amber-400 transition-colors"
                              >
                                Select
                              </button>
                            )}
                            {isSelected && (
                              <span className="px-2 py-1 text-[10px] text-amber-400">Active</span>
                            )}
                            <button
                              onClick={async () => {
                                setLocalError(null);
                                try {
                                  const { deleteModel } = await import('@/lib/local-llm');
                                  await deleteModel(entry.fileName);
                                  setLocalModels((m) => m.filter((x) => x.fileName !== entry.fileName));
                                  if (settings.localModel === entry.fileName) set('localModel', undefined as unknown as string);
                                } catch (e) {
                                  setLocalError(e instanceof Error ? e.message : 'Delete failed');
                                }
                              }}
                              className="px-2 py-1 text-[10px] rounded border border-red-300 dark:border-red-800 text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              Delete
                            </button>
                          </>
                        ) : isDownloading ? (
                          <button
                            onClick={async () => {
                              const { cancelDownload } = await import('@/lib/local-llm');
                              await cancelDownload();
                              setDownloading(null);
                              setDownloadProgress(null);
                            }}
                            className="px-2 py-1 text-[10px] rounded border border-red-300 dark:border-red-800 text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            Cancel
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              setLocalError(null);
                              if (freeSpace !== null && freeSpace < entry.sizeBytes * 1.1) {
                                setLocalError(`Not enough space. Need ${entry.sizeLabel}, have ${(freeSpace / (1024 * 1024 * 1024)).toFixed(1)} GB free.`);
                                return;
                              }
                              setDownloading(entry.fileName);
                              setDownloadProgress({ bytesDownloaded: 0, totalBytes: entry.sizeBytes });
                              try {
                                const { downloadModel } = await import('@/lib/local-llm');
                                await downloadModel(entry, (p) => setDownloadProgress(p));
                                const { listModels, getFreeDiskSpace } = await import('@/lib/local-llm');
                                setLocalModels(await listModels());
                                setFreeSpace(await getFreeDiskSpace());
                                // Auto-select if first model
                                if (!settings.localModel) set('localModel', entry.fileName);
                              } catch (e) {
                                setLocalError(e instanceof Error ? e.message : 'Download failed');
                              } finally {
                                setDownloading(null);
                                setDownloadProgress(null);
                              }
                            }}
                            className="px-2 py-1 text-[10px] rounded border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:border-amber-500/50 hover:text-amber-400 transition-colors"
                          >
                            Download
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Download progress bar */}
                    {isDownloading && downloadProgress && (
                      <div className="mt-2">
                        <div className="h-1.5 rounded-full bg-stone-200 dark:bg-zinc-700 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-500 transition-all duration-300"
                            style={{ width: `${Math.round((downloadProgress.bytesDownloaded / downloadProgress.totalBytes) * 100)}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-stone-400 dark:text-zinc-500 mt-1">
                          {(downloadProgress.bytesDownloaded / (1024 * 1024)).toFixed(0)} / {(downloadProgress.totalBytes / (1024 * 1024)).toFixed(0)} MB
                          ({Math.round((downloadProgress.bytesDownloaded / downloadProgress.totalBytes) * 100)}%)
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {localError && (
              <p className="text-xs text-red-400 text-center">{localError}</p>
            )}

            <p className="text-[10px] text-stone-400 dark:text-zinc-600 text-center">
              Chat only — book analysis requires a cloud provider.
              <br />Models run entirely on your device. No data is sent anywhere.
            </p>
          </div>
        )}
```

- [ ] **Step 5: Skip test connection for local provider**

The "Test connection" button doesn't apply to local inference. Wrap the test connection section so it only renders for non-local providers. Find the test connection `<div>` (around line 452) and wrap it:

```typescript
        {settings.provider !== 'local' && (
          <div>
            {/* ... existing test connection button and status ... */}
          </div>
        )}
```

- [ ] **Step 6: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add components/SettingsModal.tsx
git commit -m "feat: add on-device model management UI to Settings"
```

---

### Task 8: Unload Model on Chat Close

**Files:**
- Modify: `components/ChatPanel.tsx`

When the user closes the ChatPanel while using the local provider, unload the model to free RAM. The idle timer in `local-llm.ts` handles the timeout case, but explicit unload on close gives immediate memory relief.

- [ ] **Step 1: Add cleanup effect to ChatPanel**

Inside the `ChatPanel` component, add an effect that unloads the model when the panel unmounts:

```typescript
  useEffect(() => {
    return () => {
      if (isLocalProvider) {
        import('@/lib/local-llm').then(({ unloadModel }) => {
          unloadModel().catch(() => {});
        });
      }
    };
  }, [isLocalProvider]);
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add components/ChatPanel.tsx
git commit -m "feat: unload local model when ChatPanel closes"
```

---

### Task 9: End-to-End Verification

This task is manual on-device testing since the feature requires native Android code.

- [ ] **Step 1: Build the mobile APK**

```bash
npm run cap:sync
cd android && ./gradlew assembleDebug
```

- [ ] **Step 2: Install and test on an Android device or emulator**

1. Install the APK
2. Open Settings, select "On-device (free)"
3. Verify the model list appears with sizes and download buttons
4. Download Gemma 4 E2B — verify progress bar advances and completes
5. Verify the model shows as "Active" after download
6. Open a book that has been analyzed, open Chat
7. Send a message — verify "Loading AI model..." appears on first message
8. Verify the model responds with a relevant answer about the book
9. Close the chat panel, wait, reopen and send a message — verify it loads again (was unloaded)
10. Go to Settings, delete the model — verify it's removed and space is reclaimed

- [ ] **Step 3: Test error scenarios**

1. Try chatting with no model downloaded — verify helpful error message
2. Cancel a download mid-way — verify partial file is cleaned up
3. If possible, test on a low-RAM device — verify OOM is caught gracefully

- [ ] **Step 4: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: address issues found during on-device chat integration testing"
```
