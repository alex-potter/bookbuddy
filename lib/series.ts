import type { BookDefinition, SeriesDefinition, BookMeta, ParentArc, BookFilter } from '@/types';

export function buildInitialSeriesDefinition(
  bookMeta: BookMeta,
  detectRange: (chapters: Array<{ title: string; text: string }>) => { start: number; end: number },
  chapterTexts?: Map<number, { title: string; text: string }>,
): SeriesDefinition | null {
  if (!bookMeta.books?.length || bookMeta.books.length < 2) return null;

  const bookChapters = new Map<number, number[]>();
  for (const ch of bookMeta.chapters) {
    if (ch.bookIndex === undefined) continue;
    if (!bookChapters.has(ch.bookIndex)) bookChapters.set(ch.bookIndex, []);
    bookChapters.get(ch.bookIndex)!.push(ch.order);
  }

  const books: BookDefinition[] = [];
  for (let i = 0; i < bookMeta.books.length; i++) {
    const orders = bookChapters.get(i);
    if (!orders?.length) continue;
    orders.sort((a, b) => a - b);
    const chapterStart = orders[0];
    const chapterEnd = orders[orders.length - 1];

    let excludedChapters: number[] = [];
    if (chapterTexts) {
      const bookChapterData: Array<{ order: number; title: string; text: string }> = [];
      for (let o = chapterStart; o <= chapterEnd; o++) {
        const data = chapterTexts.get(o);
        if (data) bookChapterData.push({ order: o, ...data });
      }
      if (bookChapterData.length > 0) {
        const range = detectRange(bookChapterData);
        for (const ch of bookChapterData) {
          const relIdx = ch.order - chapterStart;
          if (relIdx < range.start || relIdx > range.end) {
            excludedChapters.push(ch.order);
          }
        }
      }
    }

    books.push({
      index: i,
      title: bookMeta.books[i],
      chapterStart,
      chapterEnd,
      excludedChapters,
      confirmed: false,
    });
  }

  const assignedOrders = new Set<number>();
  for (const b of books) {
    for (let o = b.chapterStart; o <= b.chapterEnd; o++) {
      assignedOrders.add(o);
    }
  }
  const allOrders = bookMeta.chapters.map((ch) => ch.order);
  const unassignedChapters = allOrders.filter((o) => !assignedOrders.has(o));

  return { books, unassignedChapters };
}

export function migrateToSeriesDefinition(
  bookMeta: BookMeta | undefined,
  excludedBooks: number[] | undefined,
): SeriesDefinition | null {
  if (!bookMeta?.books?.length || bookMeta.books.length < 2) return null;

  const bookChapters = new Map<number, number[]>();
  for (const ch of bookMeta.chapters) {
    if (ch.bookIndex === undefined) continue;
    if (!bookChapters.has(ch.bookIndex)) bookChapters.set(ch.bookIndex, []);
    bookChapters.get(ch.bookIndex)!.push(ch.order);
  }

  const excludedSet = new Set(excludedBooks ?? []);
  const books: BookDefinition[] = [];
  for (let i = 0; i < bookMeta.books.length; i++) {
    const orders = bookChapters.get(i);
    if (!orders?.length) continue;
    orders.sort((a, b) => a - b);
    const chapterStart = orders[0];
    const chapterEnd = orders[orders.length - 1];

    const excludedChapters = excludedSet.has(i)
      ? Array.from({ length: chapterEnd - chapterStart + 1 }, (_, j) => chapterStart + j)
      : [];

    books.push({
      index: i,
      title: bookMeta.books[i],
      chapterStart,
      chapterEnd,
      excludedChapters,
      confirmed: false,
    });
  }

  const assignedOrders = new Set<number>();
  for (const b of books) {
    for (let o = b.chapterStart; o <= b.chapterEnd; o++) {
      assignedOrders.add(o);
    }
  }
  const allOrders = bookMeta.chapters.map((ch) => ch.order);
  const unassignedChapters = allOrders.filter((o) => !assignedOrders.has(o));

  return { books, unassignedChapters };
}

export function computeArcGroupingHash(book: BookDefinition): string {
  const data = `${book.chapterStart}:${book.chapterEnd}:${book.excludedChapters.sort((a, b) => a - b).join(',')}`;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function isBookArcStale(book: BookDefinition): boolean {
  if (!book.parentArcs?.length) return false;
  if (!book.arcGroupingHash) return true;
  return computeArcGroupingHash(book) !== book.arcGroupingHash;
}


export function findBookForChapter(series: SeriesDefinition, chapterOrder: number): BookDefinition | undefined {
  return series.books.find((b) => chapterOrder >= b.chapterStart && chapterOrder <= b.chapterEnd);
}

export function arcBookIndices(
  arcChapters: number[],
  series: SeriesDefinition,
): number[] {
  const indices = new Set<number>();
  for (const ch of arcChapters) {
    const book = findBookForChapter(series, ch);
    if (book) indices.add(book.index);
  }
  return [...indices].sort((a, b) => a - b);
}

export function getActiveParentArcs(
  series: SeriesDefinition,
  filter: BookFilter,
  fallbackParentArcs?: ParentArc[],
): ParentArc[] {
  if (filter.mode === 'all') {
    return series.seriesArcs ?? fallbackParentArcs ?? [];
  }
  const result: ParentArc[] = [];
  for (const b of series.books) {
    if (b.excluded) continue;
    if (filter.indices.includes(b.index) && b.parentArcs?.length) {
      result.push(...b.parentArcs);
    }
  }
  return result;
}

export function getStaleBooks(series: SeriesDefinition): BookDefinition[] {
  return series.books.filter(isBookArcStale);
}
