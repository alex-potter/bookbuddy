'use client';

import { useState } from 'react';
import { loadAiSettings, saveAiSettings, type AiSettings } from '@/lib/ai-client';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof AiSettings>(key: K, value: AiSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    saveAiSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-md p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">AI Settings</h2>
          <button onClick={onClose} className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none">✕</button>
        </div>

        {/* Provider */}
        <div>
          <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-2">Provider</label>
          <div className="flex rounded-lg overflow-hidden border border-stone-300 dark:border-zinc-700">
            {(['ollama', 'anthropic'] as const).map((p) => (
              <button
                key={p}
                onClick={() => set('provider', p)}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${
                  settings.provider === p ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100' : 'bg-transparent text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
                }`}
              >
                {p === 'ollama' ? 'Ollama (local)' : 'Anthropic API'}
              </button>
            ))}
          </div>
        </div>

        {/* Ollama URL */}
        {settings.provider === 'ollama' && (
          <div>
            <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Ollama Base URL</label>
            <input
              type="url"
              value={settings.ollamaUrl}
              onChange={(e) => set('ollamaUrl', e.target.value)}
              placeholder="http://192.168.1.x:11434/v1"
              className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500"
            />
            <p className="mt-1 text-xs text-stone-400 dark:text-zinc-600">
              Use your PC&apos;s local IP so the phone can reach it over WiFi.
              Ollama must allow the app&apos;s origin:{' '}
              <code className="text-stone-400 dark:text-zinc-500">OLLAMA_ORIGINS=*</code>
            </p>
          </div>
        )}

        {/* Anthropic key */}
        {settings.provider === 'anthropic' && (
          <div>
            <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Anthropic API Key</label>
            <input
              type="password"
              value={settings.anthropicKey}
              onChange={(e) => set('anthropicKey', e.target.value)}
              placeholder="sk-ant-…"
              className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500"
            />
            <p className="mt-1 text-xs text-stone-400 dark:text-zinc-600">Stored locally on this device only.</p>
          </div>
        )}

        {/* Model */}
        <div>
          <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Model</label>
          <input
            type="text"
            value={settings.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder={settings.provider === 'ollama' ? 'qwen2.5:14b' : 'claude-haiku-4-5-20251001'}
            className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500"
          />
        </div>

        <button
          onClick={handleSave}
          className="w-full py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-zinc-900 hover:bg-amber-400 transition-colors"
        >
          {saved ? 'Saved ✓' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
