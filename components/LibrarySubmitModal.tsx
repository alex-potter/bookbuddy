'use client';

import { useEffect, useState } from 'react';
import { loadBookState, loadBookMapState } from '@/lib/book-storage';
import type { StoredBookState } from '@/types';

interface Props {
  title: string;
  author: string;
  onClose: () => void;
}

interface Stats {
  chapterCount: number;
  chaptersAnalyzed: number;
  characters: number;
  locations: number;
  arcs: number;
}

function extractStats(state: StoredBookState): Stats {
  return {
    chapterCount: state.bookMeta?.chapters?.length ?? 0,
    chaptersAnalyzed: state.lastAnalyzedIndex >= 0 ? state.lastAnalyzedIndex + 1 : 0,
    characters: state.result?.characters?.length ?? 0,
    locations: state.result?.locations?.length ?? 0,
    arcs: state.result?.arcs?.length ?? 0,
  };
}

export default function LibrarySubmitModal({ title, author, onClose }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    loadBookState(title, author).then((state) => {
      if (state) setStats(extractStats(state));
    });
  }, [title, author]);

  async function handleSubmit() {
    const state = await loadBookState(title, author);
    if (!state) return;
    const mapState = await loadBookMapState(title, author);
    const payload = { version: 2, title, author, state, mapState };

    // Create .zip containing the .bookbuddy file
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const filename = `${title} — ${author}.bookbuddy`;
    zip.file(filename, JSON.stringify(payload));
    const blob = await zip.generateAsync({ type: 'blob' });

    // Download the zip
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title} — ${author}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    // Open pre-filled GitHub issue
    const params = new URLSearchParams({
      title: `[Library] ${title} — ${author}`,
      body: `## Book Submission

- **Title:** ${title}
- **Author:** ${author}
- **Chapters analyzed:** ${stats?.chaptersAnalyzed ?? 'unknown'}
- **Characters:** ${stats?.characters ?? 'unknown'}
- **Locations:** ${stats?.locations ?? 'unknown'}

## Attach File

Please drag and drop the downloaded \`.zip\` file into this text area,
or click **Attach files** below.

---
*Submitted via BookBuddy*`,
    });
    window.open(`https://github.com/alex-potter/bookbuddy/issues/new?${params.toString()}`, '_blank');

    setSubmitted(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-md p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">Share to Library</h2>
          <button onClick={onClose} className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none">✕</button>
        </div>

        {!submitted ? (
          <>
            <div>
              <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{title}</p>
              <p className="text-xs text-stone-400 dark:text-zinc-500">{author}</p>
            </div>

            {stats && (
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-stone-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-stone-400 dark:text-zinc-500">Chapters analyzed</p>
                  <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{stats.chaptersAnalyzed}{stats.chapterCount > 0 ? ` / ${stats.chapterCount}` : ''}</p>
                </div>
                <div className="bg-stone-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-stone-400 dark:text-zinc-500">Characters</p>
                  <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{stats.characters}</p>
                </div>
                <div className="bg-stone-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-stone-400 dark:text-zinc-500">Locations</p>
                  <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{stats.locations}</p>
                </div>
                <div className="bg-stone-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-stone-400 dark:text-zinc-500">Story arcs</p>
                  <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{stats.arcs}</p>
                </div>
              </div>
            )}

            <p className="text-xs text-stone-400">Only analysis data is shared — no EPUB text or personal data.</p>

            <button
              onClick={handleSubmit}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-zinc-900 hover:bg-amber-400 transition-colors"
            >
              Prepare Submission
            </button>
          </>
        ) : (
          <>
            <div className="text-center space-y-2">
              <p className="text-2xl">✓</p>
              <h3 className="font-semibold text-stone-800 dark:text-zinc-200">Almost there!</h3>
            </div>

            <ol className="space-y-3 text-sm text-stone-600 dark:text-zinc-400">
              <li className="flex gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-500 text-xs font-bold flex items-center justify-center">1</span>
                <span>A <code className="text-xs bg-stone-100 dark:bg-zinc-800 px-1 rounded">.zip</code> file was downloaded to your device</span>
              </li>
              <li className="flex gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-500 text-xs font-bold flex items-center justify-center">2</span>
                <span>A GitHub issue opened in a new tab — attach the zip file there</span>
              </li>
            </ol>

            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-zinc-900 hover:bg-amber-400 transition-colors"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
