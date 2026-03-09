import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface CalibreBookRaw {
  title: string;
  authors: string[];
  series: string | null;
  series_index: number | null;
  format_metadata: Record<string, unknown>;
  cover: string | null;
  tags: string[];
}

export interface CalibreBook {
  id: number;
  title: string;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  formats: string[];
  hasCover: boolean;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const serverUrl = searchParams.get('serverUrl');
  const query = searchParams.get('query') ?? '';
  const libraryId = searchParams.get('libraryId') ?? '';
  const offset = parseInt(searchParams.get('offset') ?? '0', 10);
  const num = 48;

  if (!serverUrl) return NextResponse.json({ error: 'Missing serverUrl' }, { status: 400 });

  try {
    // 1. Search for book IDs
    const searchUrl = new URL(`${serverUrl}/ajax/search`);
    searchUrl.searchParams.set('query', query);
    searchUrl.searchParams.set('num', String(num));
    searchUrl.searchParams.set('offset', String(offset));
    searchUrl.searchParams.set('sort', 'title');
    if (libraryId) searchUrl.searchParams.set('library_id', libraryId);

    const searchRes = await fetch(searchUrl.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!searchRes.ok) throw new Error(`Search failed: ${searchRes.status}`);
    const searchData = await searchRes.json() as { book_ids: number[]; total_num: number };

    if (!searchData.book_ids?.length) {
      return NextResponse.json({ books: [], total: searchData.total_num ?? 0 });
    }

    // 2. Fetch metadata for those IDs
    const booksUrl = new URL(`${serverUrl}/ajax/books`);
    booksUrl.searchParams.set('ids', searchData.book_ids.join(','));
    if (libraryId) booksUrl.searchParams.set('library_id', libraryId);

    const booksRes = await fetch(booksUrl.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!booksRes.ok) throw new Error(`Metadata fetch failed: ${booksRes.status}`);
    const booksData = await booksRes.json() as Record<string, CalibreBookRaw>;

    const books: CalibreBook[] = searchData.book_ids
      .filter((id) => booksData[String(id)])
      .map((id) => {
        const b = booksData[String(id)];
        return {
          id,
          title: b.title,
          authors: b.authors ?? [],
          series: b.series ?? null,
          seriesIndex: b.series_index ?? null,
          formats: Object.keys(b.format_metadata ?? {}).map((f) => f.toUpperCase()),
          hasCover: !!b.cover,
        };
      });

    return NextResponse.json({ books, total: searchData.total_num });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
