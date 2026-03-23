'use client';

import { useEffect, useState } from 'react';

const REPO = 'alex-potter/bookbuddy';
const BRANCH = 'main';

interface BookBuddyEntry {
  path: string;
  label: string;
  author: string;
  downloadUrl: string;
}

interface Props {
  onFile: (file: File) => void;
}

export default function GithubLibrary({ onFile }: Props) {
  const [entries, setEntries] = useState<BookBuddyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`)
      .then((r) => { if (!r.ok) throw new Error(`GitHub API ${r.status}`); return r.json(); })
      .then((data) => {
        const books: BookBuddyEntry[] = (data.tree as { path: string; type: string }[])
          .filter((item) => item.path.startsWith('books/') && (item.path.endsWith('.bookbuddy') || item.path.endsWith('.etbook')) && item.type === 'blob')
          .map((item) => {
            const parts = item.path.split('/');
            const filename = parts[parts.length - 1];
            const author = parts.length > 2 ? parts[parts.length - 2] : 'Unknown';
            return {
              path: item.path,
              label: filename.replace(/\.(bookbuddy|etbook)$/, ''),
              author,
              downloadUrl: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${item.path}`,
            };
          });
        setEntries(books);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load library'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSelect(entry: BookBuddyEntry) {
    setDownloading(entry.path);
    setError(null);
    try {
      const res = await fetch(entry.downloadUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const file = new File([blob], entry.label + '.bookbuddy', { type: 'application/json' });
      onFile(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(null);
    }
  }

  const byAuthor = entries.reduce<Record<string, BookBuddyEntry[]>>((acc, e) => {
    (acc[e.author] ??= []).push(e);
    return acc;
  }, {});

  if (loading) {
    return <p className="text-sm text-stone-400 dark:text-zinc-500 text-center py-10">Loading library…</p>;
  }

  if (entries.length === 0 && !error) {
    return <p className="text-sm text-stone-400 dark:text-zinc-500 text-center py-10">No books in the library yet.</p>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      {error && <p className="text-xs text-red-400">{error}</p>}
      {Object.entries(byAuthor).map(([author, books]) => (
        <div key={author}>
          <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-2">{author}</p>
          <ul className="space-y-2">
            {books.map((entry) => (
              <li key={entry.path}>
                <button
                  onClick={() => handleSelect(entry)}
                  disabled={!!downloading}
                  className="w-full text-left px-4 py-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl hover:border-stone-300 dark:hover:border-zinc-700 transition-colors disabled:opacity-50"
                >
                  <span className="text-sm text-stone-800 dark:text-zinc-200">
                    {downloading === entry.path ? 'Downloading…' : entry.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mt-6 pt-4 border-t border-stone-200 dark:border-zinc-800 text-center">
        <p className="text-xs text-stone-400 dark:text-zinc-500">
          Analyzed a book? Share it from your <span className="text-amber-400 font-medium">My Books</span> tab.
        </p>
      </div>
    </div>
  );
}
