'use client';

import { useState } from 'react';
import type { SeriesDefinition, BookDefinition } from '@/types';

interface Props {
  series: SeriesDefinition;
  chapters: Array<{
    order: number;
    title: string;
    bookIndex?: number;
    preview?: string;
    contentType?: 'story' | 'front-matter' | 'back-matter' | 'structural';
  }>;
  onSave: (series: SeriesDefinition) => void;
  onClose: () => void;
  mode: 'setup' | 'manage';
}

export default function BookStructureEditor({ series, chapters, onSave, onClose, mode }: Props) {
  const [books, setBooks] = useState<BookDefinition[]>(() => [...series.books].sort((a, b) => a.index - b.index));
  const [editingTitle, setEditingTitle] = useState<number | null>(null);
  const [expandedBook, setExpandedBook] = useState<number | null>(null);

  const assignedOrders = new Set<number>();
  for (const b of books) {
    for (let o = b.chapterStart; o <= b.chapterEnd; o++) assignedOrders.add(o);
  }
  const unassigned = chapters.filter((ch) => !assignedOrders.has(ch.order));

  function getChapterTitle(order: number): string {
    return chapters.find((ch) => ch.order === order)?.title ?? `Chapter ${order + 1}`;
  }

  function getContentTypeLabel(order: number): string | null {
    const ch = chapters.find((c) => c.order === order);
    if (!ch?.contentType || ch.contentType === 'story') return null;
    return ch.contentType.replace('-', ' ');
  }

  function getChapterPreview(order: number): string | null {
    return chapters.find((c) => c.order === order)?.preview ?? null;
  }

  function handleConfirmAll() {
    const confirmed = books.map((b) => {
      const nonStoryOrders: number[] = [];
      for (let o = b.chapterStart; o <= b.chapterEnd; o++) {
        const ch = chapters.find((c) => c.order === o);
        if (ch?.contentType && ch.contentType !== 'story' && !b.excludedChapters.includes(o)) {
          nonStoryOrders.push(o);
        }
      }
      return {
        ...b,
        confirmed: true,
        excludedChapters: [...b.excludedChapters, ...nonStoryOrders],
      };
    });
    setBooks(confirmed);
    onSave({ ...series, books: confirmed, unassignedChapters: unassigned.map((ch) => ch.order) });
  }

  function handleUpdateBook(index: number, updates: Partial<BookDefinition>) {
    setBooks((prev) => prev.map((b) => b.index === index ? { ...b, ...updates } : b));
  }

  function handleToggleExcluded(bookIndex: number, chapterOrder: number) {
    setBooks((prev) => prev.map((b) => {
      if (b.index !== bookIndex) return b;
      const excluded = new Set(b.excludedChapters);
      if (excluded.has(chapterOrder)) excluded.delete(chapterOrder); else excluded.add(chapterOrder);
      return { ...b, excludedChapters: [...excluded] };
    }));
  }

  function handleSplitBook(bookIndex: number, splitAtOrder: number) {
    setBooks((prev) => {
      const book = prev.find((b) => b.index === bookIndex);
      if (!book || splitAtOrder <= book.chapterStart || splitAtOrder > book.chapterEnd) return prev;

      const maxIdx = Math.max(...prev.map((b) => b.index));
      const book1: BookDefinition = {
        ...book,
        chapterEnd: splitAtOrder - 1,
        excludedChapters: book.excludedChapters.filter((o) => o < splitAtOrder),
        parentArcs: undefined,
        arcGroupingHash: undefined,
      };
      const book2: BookDefinition = {
        index: maxIdx + 1,
        title: `${book.title} (Part 2)`,
        chapterStart: splitAtOrder,
        chapterEnd: book.chapterEnd,
        excludedChapters: book.excludedChapters.filter((o) => o >= splitAtOrder),
        confirmed: false,
      };
      return [...prev.filter((b) => b.index !== bookIndex), book1, book2].sort((a, b) => a.chapterStart - b.chapterStart);
    });
  }

  function handleMergeWithNext(bookIndex: number) {
    setBooks((prev) => {
      const sorted = [...prev].sort((a, b) => a.chapterStart - b.chapterStart);
      const idx = sorted.findIndex((b) => b.index === bookIndex);
      if (idx < 0 || idx >= sorted.length - 1) return prev;

      const current = sorted[idx];
      const next = sorted[idx + 1];
      const merged: BookDefinition = {
        ...current,
        chapterEnd: next.chapterEnd,
        excludedChapters: [...current.excludedChapters, ...next.excludedChapters],
        parentArcs: undefined,
        arcGroupingHash: undefined,
      };
      return prev.filter((b) => b.index !== next.index).map((b) => b.index === bookIndex ? merged : b);
    });
  }

  function handleCreateBookFromUnassigned() {
    if (unassigned.length === 0) return;
    const orders = unassigned.map((ch) => ch.order).sort((a, b) => a - b);
    const maxIdx = books.length > 0 ? Math.max(...books.map((b) => b.index)) + 1 : 0;
    const newBook: BookDefinition = {
      index: maxIdx,
      title: `Book ${maxIdx + 1}`,
      chapterStart: orders[0],
      chapterEnd: orders[orders.length - 1],
      excludedChapters: [],
      confirmed: false,
    };
    setBooks((prev) => [...prev, newBook].sort((a, b) => a.chapterStart - b.chapterStart));
  }

  function handleSave() {
    const reindexed = [...books].sort((a, b) => a.chapterStart - b.chapterStart).map((b, i) => ({ ...b, index: i }));
    const assignedSet = new Set<number>();
    for (const b of reindexed) {
      for (let o = b.chapterStart; o <= b.chapterEnd; o++) assignedSet.add(o);
    }
    const newUnassigned = chapters.filter((ch) => !assignedSet.has(ch.order)).map((ch) => ch.order);
    onSave({ ...series, books: reindexed, unassignedChapters: newUnassigned });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3 border-b border-stone-200 dark:border-zinc-800">
          <div>
            <h2 className="font-bold text-stone-900 dark:text-zinc-100 text-base">
              {mode === 'setup' ? 'Confirm Book Structure' : 'Edit Book Structure'}
            </h2>
            <p className="text-xs text-stone-500 dark:text-zinc-500 mt-0.5">
              {books.length} book{books.length !== 1 ? 's' : ''} detected · {unassigned.length} unassigned chapter{unassigned.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Book List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {[...books].sort((a, b) => a.chapterStart - b.chapterStart).map((book) => {
            const chapterCount = book.chapterEnd - book.chapterStart + 1 - book.excludedChapters.length;
            const isExpanded = expandedBook === book.index;

            return (
              <div key={book.index} className="border border-stone-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                {/* Book Header */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-stone-50 dark:hover:bg-zinc-800/50 transition-colors"
                  onClick={() => setExpandedBook(isExpanded ? null : book.index)}
                >
                  <input
                    type="checkbox"
                    checked={!book.excluded}
                    onChange={(e) => { e.stopPropagation(); handleUpdateBook(book.index, { excluded: !book.excluded }); }}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded border-stone-300 dark:border-zinc-600 text-amber-500 focus:ring-amber-500/30 flex-shrink-0"
                    title={book.excluded ? 'Include this book' : 'Exclude this book'}
                  />
                  <svg
                    className={`w-3 h-3 text-stone-400 dark:text-zinc-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 6 10" fill="currentColor"
                  >
                    <path d="M0 0l6 5-6 5V0z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    {editingTitle === book.index ? (
                      <input
                        autoFocus
                        className="w-full bg-transparent text-sm font-medium text-stone-900 dark:text-zinc-100 outline-none border-b border-amber-500"
                        defaultValue={book.title}
                        onBlur={(e) => { handleUpdateBook(book.index, { title: e.target.value }); setEditingTitle(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <p
                        className={`text-sm font-medium truncate ${book.excluded ? 'text-stone-300 dark:text-zinc-600 line-through' : 'text-stone-900 dark:text-zinc-100'}`}
                        onDoubleClick={(e) => { e.stopPropagation(); setEditingTitle(book.index); }}
                        title="Double-click to rename"
                      >
                        {book.title}
                      </p>
                    )}
                    <p className={`text-xs mt-0.5 ${book.excluded ? 'text-stone-300 dark:text-zinc-700' : 'text-stone-400 dark:text-zinc-500'}`}>
                      {getChapterTitle(book.chapterStart)} &rarr; {getChapterTitle(book.chapterEnd)}
                      <span className="ml-2">&middot; {chapterCount} ch.</span>
                    </p>
                  </div>
                  {!book.confirmed && (
                    <span className="text-xs text-amber-500 font-medium flex-shrink-0">Unconfirmed</span>
                  )}
                </div>

                {/* Expanded: Chapter List + Actions */}
                {isExpanded && (
                  <div className="border-t border-stone-200 dark:border-zinc-800 px-4 py-3 space-y-2">
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {Array.from({ length: book.chapterEnd - book.chapterStart + 1 }, (_, j) => {
                        const order = book.chapterStart + j;
                        const isExcluded = book.excludedChapters.includes(order);
                        const typeLabel = getContentTypeLabel(order);
                        const preview = getChapterPreview(order);
                        return (
                          <label key={order} className="flex items-start gap-2 text-xs cursor-pointer group">
                            <input
                              type="checkbox"
                              checked={!isExcluded}
                              onChange={() => handleToggleExcluded(book.index, order)}
                              className="rounded border-stone-300 dark:border-zinc-600 text-amber-500 focus:ring-amber-500/30 mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              <span className={`truncate block ${isExcluded ? 'text-stone-300 dark:text-zinc-600 line-through' : typeLabel ? 'text-stone-400 dark:text-zinc-500 italic' : 'text-stone-600 dark:text-zinc-400'}`}>
                                {getChapterTitle(order)}
                                {typeLabel && (
                                  <span className="ml-1.5 text-[10px] text-stone-300 dark:text-zinc-600 font-medium uppercase tracking-wider">
                                    {typeLabel}
                                  </span>
                                )}
                              </span>
                              {preview && /^Part \d+$/.test(getChapterTitle(order)) && (
                                <span className="text-[11px] text-stone-400 dark:text-zinc-500 truncate block">
                                  {preview}
                                </span>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <div className="flex gap-2 pt-2 border-t border-stone-100 dark:border-zinc-800">
                      <button
                        onClick={(e) => { e.stopPropagation(); const mid = Math.ceil((book.chapterStart + book.chapterEnd) / 2); handleSplitBook(book.index, mid); }}
                        className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
                      >
                        Split
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleMergeWithNext(book.index); }}
                        className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
                      >
                        Merge with next
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUpdateBook(book.index, { confirmed: !book.confirmed }); }}
                        className={`text-xs transition-colors ${book.confirmed ? 'text-green-500 hover:text-green-600' : 'text-amber-500 hover:text-amber-600'}`}
                      >
                        {book.confirmed ? 'Confirmed' : 'Confirm'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Unassigned chapters */}
          {unassigned.length > 0 && (
            <div className="border border-dashed border-stone-300 dark:border-zinc-700 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Unassigned Chapters</p>
                <button
                  onClick={handleCreateBookFromUnassigned}
                  className="text-xs text-amber-500 hover:text-amber-600 font-medium transition-colors"
                >
                  Create book
                </button>
              </div>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {unassigned.map((ch) => (
                  <p key={ch.order} className="text-xs text-stone-400 dark:text-zinc-500 truncate">
                    {ch.title}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 pt-3 border-t border-stone-200 dark:border-zinc-800">
          {mode === 'setup' ? (
            <button
              onClick={handleConfirmAll}
              className="px-5 py-2 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
            >
              Confirm All &amp; Start
            </button>
          ) : (
            <button
              onClick={handleSave}
              className="px-5 py-2 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors"
            >
              Save Changes
            </button>
          )}
          <button
            onClick={onClose}
            className="text-sm text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors"
          >
            {mode === 'setup' ? 'Skip' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
