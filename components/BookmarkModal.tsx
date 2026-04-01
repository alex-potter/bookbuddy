'use client';

import { normalizeTitle } from '@/lib/normalize-title';
import type { EbookChapter } from '@/types';

interface Props {
  chapters: EbookChapter[];
  currentBookmark: number | null;
  mode: 'import' | 'update';
  onSelect: (chapterIndex: number | null) => void;
  onClose: () => void;
}

export default function BookmarkModal({ chapters, currentBookmark, mode, onSelect, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-md p-6 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">
            {mode === 'import' ? 'Where are you in this book?' : 'Update your bookmark'}
          </h2>
          <button
            onClick={onClose}
            className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-stone-500 dark:text-zinc-500 mb-3">
          {mode === 'import'
            ? 'Set your reading position to avoid spoilers.'
            : 'Tap the chapter you\'ve read up to.'}
        </p>

        {/* Chapter list */}
        <div className="overflow-y-auto flex-1 -mx-2">
          {/* "I haven't started yet" option */}
          <button
            onClick={() => onSelect(0)}
            className={`w-full text-left px-3 py-3 text-sm rounded-lg transition-colors flex items-center gap-2 ${
              currentBookmark === 0
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium'
                : 'text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800'
            }`}
          >
            <span className="text-base">📖</span>
            I haven&apos;t started yet
          </button>

          {chapters.map((ch, i) => (
            <button
              key={i}
              onClick={() => onSelect(i)}
              className={`w-full text-left px-3 py-3 text-sm rounded-lg transition-colors truncate ${
                i === currentBookmark
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium'
                  : 'text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800'
              }`}
            >
              {i + 1}. {normalizeTitle(ch.title)}
            </button>
          ))}

          {/* Clear bookmark — update mode only */}
          {mode === 'update' && currentBookmark != null && (
            <button
              onClick={() => onSelect(null)}
              className="w-full text-left px-3 py-3 text-sm rounded-lg transition-colors text-red-400 hover:bg-red-500/10 mt-2 border-t border-stone-200 dark:border-zinc-800 pt-3"
            >
              Clear bookmark
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
