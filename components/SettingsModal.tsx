'use client';

import { useState } from 'react';
import { loadAiSettings, saveAiSettings, testConnection, diagnoseOllamaConnection, type AiSettings } from '@/lib/ai-client';

interface Props {
  onClose: () => void;
}

const OLLAMA_MODELS = ['qwen2.5:32b', 'qwen2.5:14b', 'qwen2.5:7b', 'llama3.1:8b', 'mistral', 'gemma3:12b'];
const ANTHROPIC_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast, cheap)' },
  { id: 'claude-sonnet-4-5-20251022', label: 'Sonnet 4.5 (smarter)' },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5 (best)' },
];

type TestState = 'idle' | 'testing' | 'ok' | 'error' | 'cors-error' | 'unreachable';

export default function SettingsModal({ onClose }: Props) {
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);

  function set<K extends keyof AiSettings>(key: K, value: AiSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setTestState('idle');
  }

  function handleSave() {
    saveAiSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleTest() {
    setTestState('testing');
    setTestMsg('');
    try {
      // Run Ollama-specific diagnostics first
      if (settings.provider === 'ollama' && settings.ollamaUrl) {
        const diag = await diagnoseOllamaConnection(settings.ollamaUrl);
        if (!diag.reachable) {
          setTestState('unreachable');
          setTestMsg(diag.hint ?? 'Cannot reach Ollama.');
          return;
        }
        if (!diag.corsOk) {
          setTestState('cors-error');
          setTestMsg(diag.hint ?? 'CORS blocked.');
          setGuideOpen(true);
          return;
        }
      }
      const reply = await testConnection(settings);
      setTestState('ok');
      setTestMsg(reply.slice(0, 80));
    } catch (err) {
      setTestState('error');
      setTestMsg(err instanceof Error ? err.message : 'Connection failed');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-md p-6 space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">AI Settings</h2>
          <button onClick={onClose} className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none">✕</button>
        </div>

        {/* Provider toggle */}
        <div>
          <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-2">Provider</label>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-stone-300 dark:border-zinc-700 p-1">
            {([
              { value: 'ollama' as const, label: 'Ollama (local)' },
              { value: 'anthropic' as const, label: 'Anthropic' },
              { value: 'gemini' as const, label: 'Gemini (free)' },
              { value: 'openai-compatible' as const, label: settings.openaiCompatibleName || 'OpenAI-compat' },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                onClick={() => set('provider', opt.value)}
                className={`py-1.5 text-xs font-medium rounded-md transition-colors ${
                  settings.provider === opt.value
                    ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100'
                    : 'text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Ollama config */}
        {settings.provider === 'ollama' && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Ollama Base URL</label>
              <input
                type="url"
                value={settings.ollamaUrl}
                onChange={(e) => set('ollamaUrl', e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
              <p className="mt-1 text-xs text-stone-400 dark:text-zinc-600">
                On mobile, use your PC&apos;s local IP. Requires <code className="text-stone-500 dark:text-zinc-500">OLLAMA_ORIGINS=*</code> — see setup guide below.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Model</label>
              <input
                type="text"
                value={settings.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder="qwen2.5:14b"
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {OLLAMA_MODELS.map((m) => (
                  <button
                    key={m}
                    onClick={() => set('model', m)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${settings.model === m ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-600 hover:border-stone-400 dark:hover:border-zinc-500 hover:text-stone-600 dark:hover:text-zinc-400'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Ollama Setup Guide */}
            <div className="rounded-lg border border-stone-300 dark:border-zinc-700 overflow-hidden">
              <button
                type="button"
                onClick={() => setGuideOpen(!guideOpen)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
              >
                <span>Ollama Setup Guide</span>
                <span className="text-[10px]">{guideOpen ? '▲' : '▼'}</span>
              </button>
              {guideOpen && (
                <div className="px-3 pb-3 space-y-2 text-xs text-stone-500 dark:text-zinc-400">
                  <p>Ollama must allow cross-origin requests by setting <code className="text-stone-500 dark:text-zinc-500">OLLAMA_ORIGINS=*</code>. Since Ollama typically runs as a background service, set this as a persistent environment variable:</p>

                  <div className="space-y-1.5">
                    <p className="font-medium text-stone-600 dark:text-zinc-300">Windows:</p>
                    <p>Set via Settings &gt; System &gt; Environment Variables, or run:</p>
                    <pre className="bg-stone-100 dark:bg-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto">setx OLLAMA_ORIGINS &quot;*&quot;</pre>
                    <p>Then quit Ollama from the system tray and reopen it.</p>

                    <p className="font-medium text-stone-600 dark:text-zinc-300">macOS:</p>
                    <pre className="bg-stone-100 dark:bg-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto">launchctl setenv OLLAMA_ORIGINS &quot;*&quot;</pre>
                    <p>Then quit and reopen Ollama from the menu bar.</p>

                    <p className="font-medium text-stone-600 dark:text-zinc-300">Linux (systemd):</p>
                    <pre className="bg-stone-100 dark:bg-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">{`sudo systemctl edit ollama\n# Add under [Service]:\n# Environment="OLLAMA_ORIGINS=*"\nsudo systemctl restart ollama`}</pre>

                    <p className="font-medium text-stone-600 dark:text-zinc-300">Docker:</p>
                    <pre className="bg-stone-100 dark:bg-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto">docker run -e OLLAMA_ORIGINS=* -p 11434:11434 ollama/ollama</pre>
                  </div>

                  <details className="mt-1">
                    <summary className="cursor-pointer text-stone-400 dark:text-zinc-500 hover:text-stone-600 dark:hover:text-zinc-300 transition-colors">Manual terminal option</summary>
                    <div className="mt-1.5 space-y-1.5 pl-2 border-l-2 border-stone-200 dark:border-zinc-700">
                      <p>If you prefer to run Ollama manually, stop the background service first, then:</p>
                      <p className="font-medium text-stone-600 dark:text-zinc-300">macOS / Linux:</p>
                      <pre className="bg-stone-100 dark:bg-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto">OLLAMA_ORIGINS=* ollama serve</pre>
                      <p className="font-medium text-stone-600 dark:text-zinc-300">Windows (PowerShell):</p>
                      <pre className="bg-stone-100 dark:bg-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] overflow-x-auto">$env:OLLAMA_ORIGINS=&quot;*&quot;; ollama serve</pre>
                    </div>
                  </details>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Anthropic config */}
        {settings.provider === 'anthropic' && (
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500">Anthropic API Key</label>
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-amber-400 hover:text-amber-300 transition-colors"
                >
                  Get a key →
                </a>
              </div>
              <input
                type="password"
                value={settings.anthropicKey}
                onChange={(e) => set('anthropicKey', e.target.value)}
                placeholder="sk-ant-…"
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
              <p className="mt-1 text-xs text-stone-400 dark:text-zinc-600">Stored on this device only — never sent to our servers.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Model</label>
              <div className="space-y-1.5">
                {ANTHROPIC_MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => set('model', m.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${settings.model === m.id ? 'border-amber-500/50 bg-amber-500/10 text-amber-300' : 'border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:border-stone-400 dark:hover:border-zinc-600'}`}
                  >
                    <span className="font-mono text-xs">{m.id.split('-').slice(0, 3).join('-')}</span>
                    <span className="ml-2 text-xs text-stone-400 dark:text-zinc-500">{m.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Gemini config */}
        {settings.provider === 'gemini' && (
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-stone-400 dark:text-zinc-500">API Key</label>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline"
                >
                  Get a free key
                </a>
              </div>
              <input
                type="password"
                value={settings.geminiKey}
                onChange={(e) => set('geminiKey', e.target.value)}
                placeholder="AIza..."
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Model</label>
              <select
                value={settings.model}
                onChange={(e) => set('model', e.target.value)}
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              >
                <option value="gemini-2.0-flash">Gemini 2.0 Flash (fast, recommended)</option>
                <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite (fastest)</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro (smartest)</option>
              </select>
            </div>
            <p className="text-[10px] text-stone-400 dark:text-zinc-600">
              Free tier — no credit card required. Your key is stored on this device only.
            </p>
          </div>
        )}

        {/* OpenAI-compatible config */}
        {settings.provider === 'openai-compatible' && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Provider Name</label>
              <input
                type="text"
                value={settings.openaiCompatibleName}
                onChange={(e) => set('openaiCompatibleName', e.target.value)}
                placeholder="e.g. Groq, OpenRouter"
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] text-stone-400 dark:text-zinc-600 self-center">Quick setup:</span>
              {[
                { name: 'Groq', url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
                { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
                { name: 'Cerebras', url: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
              ].map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => {
                    set('openaiCompatibleName', preset.name);
                    set('openaiCompatibleUrl', preset.url);
                    set('model', preset.model);
                  }}
                  className="px-2 py-0.5 text-[10px] rounded-full border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Base URL</label>
              <input
                type="url"
                value={settings.openaiCompatibleUrl}
                onChange={(e) => set('openaiCompatibleUrl', e.target.value)}
                placeholder="https://api.groq.com/openai/v1"
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">API Key</label>
              <input
                type="password"
                value={settings.openaiCompatibleKey}
                onChange={(e) => set('openaiCompatibleKey', e.target.value)}
                placeholder="sk-... or gsk-..."
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-400 dark:text-zinc-500 mb-1.5">Model</label>
              <input
                type="text"
                value={settings.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder="llama-3.3-70b-versatile"
                className="w-full bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-amber-500/50"
              />
            </div>
          </div>
        )}

        {/* Test connection */}
        <div>
          <button
            onClick={handleTest}
            disabled={testState === 'testing'}
            className="w-full py-2 rounded-lg text-sm font-medium border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:border-stone-400 dark:hover:border-zinc-600 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testState === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {testState === 'ok' && (
            <p className="mt-1.5 text-xs text-emerald-400 text-center">✓ Connected — model replied: &ldquo;{testMsg}&rdquo;</p>
          )}
          {testState === 'cors-error' && (
            <div className="mt-1.5 text-center space-y-1">
              <p className="text-xs text-red-400">✗ {testMsg}</p>
              {!guideOpen && (
                <button
                  onClick={() => setGuideOpen(true)}
                  className="text-[11px] text-amber-400 hover:text-amber-300 transition-colors"
                >
                  Show setup guide ↑
                </button>
              )}
            </div>
          )}
          {testState === 'unreachable' && (
            <p className="mt-1.5 text-xs text-red-400 text-center">✗ {testMsg}</p>
          )}
          {testState === 'error' && (
            <p className="mt-1.5 text-xs text-red-400 text-center">✗ {testMsg}</p>
          )}
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
