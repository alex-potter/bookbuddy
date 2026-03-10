import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function POST(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url?: string };
    if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 });

    // Only allow http/https
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return NextResponse.json({ error: 'Invalid URL protocol' }, { status: 400 });
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ebook-tracker/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `Fetch failed: ${res.status}` }, { status: 502 });
    }

    const contentType = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!ALLOWED_TYPES.has(contentType)) {
      return NextResponse.json({ error: 'URL does not point to a supported image (JPEG, PNG, WEBP, GIF)' }, { status: 415 });
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'Image exceeds 12 MB limit' }, { status: 413 });
    }

    const base64 = Buffer.from(buffer).toString('base64');
    return NextResponse.json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
