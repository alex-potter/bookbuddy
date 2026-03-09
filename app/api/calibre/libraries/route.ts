import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const serverUrl = req.nextUrl.searchParams.get('serverUrl');
  if (!serverUrl) return NextResponse.json({ error: 'Missing serverUrl' }, { status: 400 });

  try {
    const res = await fetch(`${serverUrl}/ajax/library-info`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) throw new Error(`Calibre server responded ${res.status}`);
    const data = await res.json() as {
      library_map: Record<string, string>;
      default_library: string;
    };

    return NextResponse.json({
      libraries: Object.keys(data.library_map),
      defaultLibrary: data.default_library,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to connect';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
