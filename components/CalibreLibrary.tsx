'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalibreBook } from '@/app/api/calibre/search/route';

interface Props {
  onFile: (file: File) => void;
}

const DEFAULT_SERVER = 'http://localhost:8080';

export default function CalibreLibrary({ onFile }: Props) {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [libraryId, setLibraryId] = useState('');
  const [libraries, setLibraries] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [books, setBooks] = useState<CalibreBook[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadingBooks, setLoadingBooks] = useState(false);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch books from the proxy API
  const fetchBooks = useCallback(async (q: string, off: number, libId: string, srv: string) => {
    setLoadingBooks(true);
    setBooksError(null);
    try {
      const params = new URLSearchParams({
        serverUrl: srv,
        query: q,
        offset: String(off),
        ...(libId ? { libraryId: libId } : {}),
      });
      const res = await fetch(`/api/calibre/search?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load books');
      if (off === 0) {
        setBooks(data.books);
      } else {
        setBooks((prev) => [...prev, ...data.books]);
      }
      setTotal(data.total);
      setOffset(off);
    } catch (err: unknown) {
      setBooksError(err instanceof Error ? err.message : 'Failed to load books');
    } finally {
      setLoadingBooks(false);
    }
  }, []);

  // Connect to Calibre server
  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const params = new URLSearchParams({ serverUrl: serverUrl.trim() });
      const res = await fetch(`/api/calibre/libraries?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Cannot connect');

      setLibraries(data.libraries ?? []);
      const defaultLib = data.defaultLibrary ?? data.libraries?.[0] ?? '';
      setLibraryId(defaultLib);
      setConnected(true);
      fetchBooks('', 0, defaultLib, serverUrl.trim());
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }

  // Debounced search
  function handleSearchChange(q: string) {
    setSearch(q);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      fetchBooks(q, 0, libraryId, serverUrl);
    }, 350);
  }

  // Library switch
  function handleLibraryChange(lib: string) {
    setLibraryId(lib);
    setSearch('');
    fetchBooks('', 0, lib, serverUrl);
  }

  // Download EPUB
  async function handleBookClick(book: CalibreBook) {
    if (!book.formats.includes('EPUB')) return;
    setDownloadingId(book.id);
    try {
      const params = new URLSearchParams({
        serverUrl,
        bookId: String(book.id),
        ...(libraryId ? { libraryId } : {}),
      });
      const res = await fetch(`/api/calibre/download?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Download failed' }));
        throw new Error(err.error);
      }
      const blob = await res.blob();
      const file = new File([blob], `${book.title}.epub`, { type: 'application/epub+zip' });
      onFile(file);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingId(null);
    }
  }

  function coverUrl(book: CalibreBook) {
    if (!book.hasCover) return null;
    const base = serverUrl.replace(/\/$/, '');
    return libraryId
      ? `${base}/get/cover/${book.id}/${libraryId}`
      : `${base}/get/cover/${book.id}`;
  }

  // Connection form
  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 max-w-sm mx-auto">
        <div className="text-center">
          <div className="text-4xl mb-2 opacity-60">📚</div>
          <h2 className="font-bold text-zinc-100 text-lg">Connect to Calibre</h2>
          <p className="text-sm text-zinc-500 mt-1">
            Enable the content server in Calibre: <br />
            <span className="text-zinc-400">Preferences → Sharing over the net</span>
          </p>
        </div>

        <div className="w-full space-y-3">
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1.5">Server URL</label>
            <input
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="http://localhost:8080"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-zinc-200 text-sm focus:outline-none focus:border-zinc-500"
            />
          </div>

          {connectError && (
            <p className="text-xs text-red-400 text-center">{connectError}</p>
          )}

          <button
            onClick={handleConnect}
            disabled={connecting}
            className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              connecting
                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
            }`}
          >
            {connecting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin" />
                Connecting…
              </span>
            ) : 'Connect'}
          </button>
        </div>
      </div>
    );
  }

  const hasMore = books.length < total;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          type="search"
          placeholder="Search library…"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="flex-1 min-w-48 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
        />

        {libraries.length > 1 && (
          <select
            value={libraryId}
            onChange={(e) => handleLibraryChange(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-400 focus:outline-none focus:border-zinc-600"
          >
            {libraries.map((lib) => (
              <option key={lib} value={lib}>{lib}</option>
            ))}
          </select>
        )}

        <button
          onClick={() => { setConnected(false); setBooks([]); setSearch(''); }}
          className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors whitespace-nowrap"
        >
          Disconnect
        </button>
      </div>

      <p className="text-xs text-zinc-600 mb-3">
        {loadingBooks && books.length === 0 ? 'Loading…' : `${total} book${total !== 1 ? 's' : ''}${search ? ` matching "${search}"` : ''}`}
      </p>

      {booksError && (
        <p className="text-xs text-red-400 text-center mb-3">{booksError}</p>
      )}

      {/* Book grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 overflow-y-auto flex-1">
        {books.map((book) => {
          const hasEpub = book.formats.includes('EPUB');
          const isDownloading = downloadingId === book.id;
          const cover = coverUrl(book);

          return (
            <button
              key={book.id}
              onClick={() => hasEpub && handleBookClick(book)}
              disabled={!hasEpub || isDownloading}
              title={hasEpub ? `Open "${book.title}"` : 'No EPUB format available'}
              className={`
                group flex flex-col rounded-xl overflow-hidden border text-left transition-colors
                ${hasEpub
                  ? 'border-zinc-800 hover:border-zinc-600 cursor-pointer'
                  : 'border-zinc-800 opacity-40 cursor-not-allowed'
                }
              `}
            >
              {/* Cover */}
              <div className="relative bg-zinc-800 aspect-[2/3] flex items-center justify-center overflow-hidden">
                {isDownloading ? (
                  <div className="absolute inset-0 bg-zinc-900/70 flex items-center justify-center">
                    <span className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : null}
                {cover ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={cover}
                    alt={book.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <span className="text-3xl opacity-20">📖</span>
                )}
                {hasEpub && !isDownloading && (
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="text-white text-xs font-medium bg-amber-500 text-zinc-900 px-2 py-1 rounded-md">Open</span>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-2 bg-zinc-900 flex-1">
                <p className="text-xs font-medium text-zinc-300 leading-snug line-clamp-2">{book.title}</p>
                <p className="text-[10px] text-zinc-600 mt-0.5 truncate">{book.authors.join(', ')}</p>
                {book.series && (
                  <p className="text-[10px] text-amber-600 mt-0.5 truncate">
                    {book.series}{book.seriesIndex != null ? ` #${book.seriesIndex}` : ''}
                  </p>
                )}
                {!hasEpub && (
                  <p className="text-[10px] text-zinc-700 mt-0.5">{book.formats.join(', ') || 'No formats'}</p>
                )}
              </div>
            </button>
          );
        })}

        {/* Skeleton loaders */}
        {loadingBooks && books.length === 0 &&
          Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded-xl overflow-hidden border border-zinc-800">
              <div className="bg-zinc-800 animate-pulse aspect-[2/3]" />
              <div className="p-2 bg-zinc-900 space-y-1.5">
                <div className="h-2.5 bg-zinc-800 rounded animate-pulse" />
                <div className="h-2 bg-zinc-800 rounded animate-pulse w-2/3" />
              </div>
            </div>
          ))
        }
      </div>

      {/* Load more */}
      {hasMore && !loadingBooks && (
        <div className="mt-4 text-center">
          <button
            onClick={() => fetchBooks(search, offset + 48, libraryId, serverUrl)}
            className="px-4 py-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg transition-colors"
          >
            Load more ({total - books.length} remaining)
          </button>
        </div>
      )}

      {loadingBooks && books.length > 0 && (
        <p className="text-xs text-zinc-600 text-center mt-3">Loading…</p>
      )}
    </div>
  );
}
