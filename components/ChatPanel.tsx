'use client';

import { useEffect, useRef, useState } from 'react';
import type { AnalysisResult, Snapshot } from '@/types';
import { buildChatSystemPrompt, buildCompactChatSystemPrompt } from '@/lib/chat-context';

const IS_MOBILE = process.env.NEXT_PUBLIC_MOBILE === 'true';

interface Props {
  bookTitle: string;
  bookAuthor: string;
  lastAnalyzedIndex: number;
  currentChapterTitle: string;
  totalChapters: number;
  result: AnalysisResult;
  snapshots: Snapshot[];
  chapterTitles: string[];
  onClose: () => void;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

async function sendChat(
  systemPrompt: string,
  messages: Message[],
): Promise<string> {
  if (IS_MOBILE) {
    const { loadAiSettings, chatWithBook } = await import('@/lib/ai-client');
    return chatWithBook(systemPrompt, messages, loadAiSettings());
  }

  // Include client AI settings for server fallback
  let aiSettings: Record<string, string> = {};
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
  } catch { /* ignore */ }

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemPrompt, messages, ...aiSettings }),
  });
  const data = await res.json() as { reply?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? 'Chat failed.');
  return data.reply ?? '';
}

const SUGGESTIONS = [
  'Summarise what has happened so far',
  'Who are the most important characters?',
  'What are the key locations in the story?',
  'What are the main conflicts or tensions?',
];

export default function ChatPanel({
  bookTitle, bookAuthor, lastAnalyzedIndex, currentChapterTitle,
  totalChapters, result, snapshots, chapterTitles, onClose,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLocalProvider, setIsLocalProvider] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (isLocalProvider) {
        import('@/lib/local-llm').then(({ unloadModel }) => {
          unloadModel().catch(() => {});
        });
      }
    };
  }, [isLocalProvider]);

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    setInput('');
    setError(null);
    const next: Message[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setLoading(true);
    try {
      const reply = await sendChat(systemPrompt, next);
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const chaptersRead = lastAnalyzedIndex + 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col sm:flex-row sm:items-stretch sm:justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="hidden sm:block flex-1" />

      {/* Panel */}
      <div
        className="flex flex-col bg-white dark:bg-zinc-900 border-t sm:border-t-0 sm:border-l border-stone-200 dark:border-zinc-800 w-full sm:w-96 h-[75vh] sm:h-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 dark:border-zinc-800 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-stone-800 dark:text-zinc-200 truncate">Ask about your book</p>
            <p className="text-xs text-stone-400 dark:text-zinc-500 truncate">
              {isLocalProvider ? 'On-device AI · ' : 'Spoiler-free · '}knows ch. 1–{chaptersRead} of {totalChapters}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {messages.length > 0 && (
              <button
                onClick={() => setMessages([])}
                className="text-xs text-stone-400 dark:text-zinc-600 hover:text-stone-600 dark:hover:text-zinc-400 transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={onClose}
              className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="space-y-4">
              <p className="text-xs text-stone-400 dark:text-zinc-500 text-center">
                Ask anything about what you&apos;ve read — no spoilers.
              </p>
              <div className="space-y-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSend(s)}
                    className="w-full text-left px-3 py-2 text-xs text-stone-500 dark:text-zinc-400 bg-stone-50 dark:bg-zinc-800 hover:bg-stone-100 dark:hover:bg-zinc-700 border border-stone-200 dark:border-zinc-700 rounded-lg transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-amber-500 text-zinc-900 rounded-br-sm'
                    : 'bg-stone-100 dark:bg-zinc-800 text-stone-800 dark:text-zinc-200 rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

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

          {error && (
            <p className="text-xs text-red-400 text-center px-2">{error}</p>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="flex-shrink-0 border-t border-stone-200 dark:border-zinc-800 px-3 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about characters, plot, locations…"
              rows={1}
              className="flex-1 resize-none bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-xl px-3 py-2 text-sm text-stone-800 dark:text-zinc-200 placeholder-stone-400 dark:placeholder-zinc-600 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500 max-h-32 overflow-y-auto"
              style={{ fieldSizing: 'content' } as React.CSSProperties}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || loading}
              className="flex-shrink-0 w-9 h-9 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 flex items-center justify-center transition-colors"
            >
              ↑
            </button>
          </div>
          <p className="text-[10px] text-stone-300 dark:text-zinc-700 mt-1.5 text-center">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
    </div>
  );
}
