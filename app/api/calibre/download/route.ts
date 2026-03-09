import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const serverUrl = searchParams.get('serverUrl');
  const bookId = searchParams.get('bookId');
  const libraryId = searchParams.get('libraryId') ?? '';

  if (!serverUrl || !bookId) {
    return NextResponse.json({ error: 'Missing serverUrl or bookId' }, { status: 400 });
  }

  try {
    const downloadUrl = libraryId
      ? `${serverUrl}/get/epub/${bookId}/${libraryId}`
      : `${serverUrl}/get/epub/${bookId}`;

    const res = await fetch(downloadUrl, { cache: 'no-store', signal: AbortSignal.timeout(30000) });

    if (!res.ok) {
      // Try without library_id as fallback
      if (libraryId) {
        const fallback = await fetch(`${serverUrl}/get/epub/${bookId}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
        if (!fallback.ok) throw new Error(`Download failed: ${res.status}`);
        const body = fallback.body;
        if (!body) throw new Error('Empty response');
        return new NextResponse(body, {
          headers: {
            'Content-Type': 'application/epub+zip',
            'Content-Disposition': `attachment; filename="book-${bookId}.epub"`,
          },
        });
      }
      throw new Error(`Download failed: ${res.status}`);
    }

    const body = res.body;
    if (!body) throw new Error('Empty response from Calibre');

    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/epub+zip',
        'Content-Disposition': `attachment; filename="book-${bookId}.epub"`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Download failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
