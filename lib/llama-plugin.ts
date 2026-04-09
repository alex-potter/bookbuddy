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
