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
