'use client';

import { useEffect, useState } from 'react';

const REPO = 'alex-potter/ebook-tracker';
const BRANCH = 'main';

interface EtbookEntry {
  path: string;
  label: string;
  author: string;
  downloadUrl: string;
}

interface Props {
  onFile: (file: File) => void;
}

export default function GithubLibrary({ onFile }: Props) {
  const [entries, setEntries] = useState<EtbookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`)
      .then((r) => { if (!r.ok) throw new Error(`GitHub API ${r.status}`); return r.json(); })
      .then((data) => {
        const books: EtbookEntry[] = (data.tree as { path: string; type: string }[])
          .filter((item) => item.path.startsWith('books/') && item.path.endsWith('.etbook') && item.type === 'blob')
          .map((item) => {
            const parts = item.path.split('/');
            const filename = parts[parts.length - 1];
            const author = parts.length > 2 ? parts[parts.length - 2] : 'Unknown';
            return {
              path: item.path,
              label: filename.replace(/\.etbook$/, ''),
              author,
              downloadUrl: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${item.path}`,
            };
          });
        setEntries(books);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load library'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSelect(entry: EtbookEntry) {
    setDownloading(entry.path);
    setError(null);
    try {
      const res = await fetch(entry.downloadUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const file = new File([blob], entry.label + '.etbook', { type: 'application/json' });
      onFile(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(null);
    }
  }

  const byAuthor = entries.reduce<Record<string, EtbookEntry[]>>((acc, e) => {
    (acc[e.author] ??= []).push(e);
    return acc;
  }, {});

  if (loading) {
    return <p className="text-sm text-zinc-500 text-center py-10">Loading library…</p>;
  }

  if (entries.length === 0 && !error) {
    return <p className="text-sm text-zinc-500 text-center py-10">No books in the library yet.</p>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      {error && <p className="text-xs text-red-400">{error}</p>}
      {Object.entries(byAuthor).map(([author, books]) => (
        <div key={author}>
          <p className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2">{author}</p>
          <ul className="space-y-2">
            {books.map((entry) => (
              <li key={entry.path}>
                <button
                  onClick={() => handleSelect(entry)}
                  disabled={!!downloading}
                  className="w-full text-left px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl hover:border-zinc-700 transition-colors disabled:opacity-50"
                >
                  <span className="text-sm text-zinc-200">
                    {downloading === entry.path ? 'Downloading…' : entry.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
