import { NextRequest, NextResponse } from 'next/server';
import type { LocationPin } from '@/types';
import { callLLM, resolveConfig } from '@/lib/llm';
import { getContextWindow, resolveMaxOutputTokens } from '@/lib/context-window';

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function buildPrompt(locations: string[]): string {
  return `Look at this map image and find as many of the listed place names as you can. The names are printed as text labels directly on the map.

COORDINATE SYSTEM — read carefully:
  (0,0)─────────────────(100,0)
    │        TOP                │
    │   x increases →           │
    │   y increases ↓           │
    │        BOTTOM             │
  (0,100)────────────(100,100)

- x=0 is the LEFT edge, x=100 is the RIGHT edge
- y=0 is the TOP edge, y=100 is the BOTTOM edge
- A label near the TOP of the image has a SMALL y value (e.g. y=10)
- A label near the BOTTOM of the image has a LARGE y value (e.g. y=90)
- Examples: top-left → x=10, y=8 | centre → x=50, y=50 | bottom-right → x=88, y=92

Rules:
- Include every name from the list that you can find written on the map.
- x and y should point to the centre of the text label itself.
- Case-insensitive matching is fine (e.g. "TAR VALON" matches "Tar Valon").
- Only omit a name if you genuinely cannot find it anywhere on the map.
- If you cannot find any of the names, return {"pins": {}}.

Return ONLY this JSON (no markdown fences, no explanation):
{"pins": {"Place Name": {"x": 34.5, "y": 61.2}, ...}}

Place names to find:
${locations.map((l) => `- ${l}`).join('\n')}`;
}

function extractPins(raw: string, imageWidth?: number, imageHeight?: number): Record<string, LocationPin> {
  // First try valid JSON parse
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const rawPins: Record<string, { x: number; y: number }> = {};

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { pins?: Record<string, LocationPin> };
      for (const [name, pos] of Object.entries(parsed.pins ?? {})) {
        const x = Number(pos.x), y = Number(pos.y);
        if (!isNaN(x) && !isNaN(y)) rawPins[name] = { x, y };
      }
    } catch {
      // JSON truncated or malformed — fall through to regex recovery
    }
  }

  // Regex recovery: extract complete "name": {"x": N, "y": N} pairs from raw string
  // This handles truncated JSON where JSON.parse fails
  if (Object.keys(rawPins).length === 0) {
    const pairRe = /"([^"]+)"\s*:\s*\{\s*"x"\s*:\s*([\d.]+)\s*,\s*"y"\s*:\s*([\d.]+)\s*\}/g;
    let m;
    while ((m = pairRe.exec(raw)) !== null) {
      const name = m[1], x = Number(m[2]), y = Number(m[3]);
      if (!isNaN(x) && !isNaN(y)) rawPins[name] = { x, y };
    }
  }

  if (Object.keys(rawPins).length === 0) return {};

  // Normalize coordinates only if values are clearly pixel-scale (>200).
  // Values slightly over 100 (e.g. 103, 111) are still percentages — just clamp them.
  const allX = Object.values(rawPins).map((p) => p.x);
  const allY = Object.values(rawPins).map((p) => p.y);
  const needsNorm = Math.max(...allX) > 200 || Math.max(...allY) > 200;

  // Use actual image dimensions when available; fall back to data-max (less accurate)
  const normW = needsNorm ? (imageWidth ?? Math.max(...allX)) : 100;
  const normH = needsNorm ? (imageHeight ?? Math.max(...allY)) : 100;

  const pins: Record<string, LocationPin> = {};
  const entries = Object.entries(rawPins);
  for (let i = 0; i < entries.length; i++) {
    const [name, pos] = entries[i];
    const x = needsNorm ? (pos.x / normW) * 100 : pos.x;
    const y = needsNorm ? (pos.y / normH) * 100 : pos.y;
    pins[name] = {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
    };
  }
  return pins;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      imageDataUrl: string;
      locations: string[];
      imageWidth?: number;
      imageHeight?: number;
      _provider?: string;
      _apiKey?: string;
      _ollamaUrl?: string;
      _model?: string;
      _geminiKey?: string;
      _openaiCompatibleUrl?: string;
      _openaiCompatibleKey?: string;
      _ollamaContextLength?: number;
    };
    const { imageDataUrl, locations, imageWidth, imageHeight } = body;

    if (!imageDataUrl || !locations?.length) {
      return NextResponse.json({ error: 'Missing imageDataUrl or locations' }, { status: 400 });
    }

    const prompt = buildPrompt(locations);
    const config = resolveConfig(body, { useVisionModel: true });
    if (body._ollamaContextLength && config.provider === 'ollama') {
      (config as { contextLengthOverride?: number }).contextLengthOverride = body._ollamaContextLength;
    }
    const { contextWindow } = await getContextWindow(config);
    const maxTokens = resolveMaxOutputTokens({
      contextWindow,
      floor: 4096,
      inputChars: prompt.length,
      ceilingFraction: 0.3,
    });

    const commaIdx = imageDataUrl.indexOf(',');
    const base64Data = imageDataUrl.slice(commaIdx + 1);
    const rawType = imageDataUrl.slice(0, commaIdx).match(/data:([^;]+)/)?.[1] ?? 'image/png';
    const mediaType = SUPPORTED_TYPES.has(rawType) ? rawType : 'image/png';

    const { text: raw } = await callLLM({
      ...config,
      system: '',
      userPrompt: prompt,
      maxTokens,
      images: [{ data: base64Data, mimeType: mediaType }],
    });

    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    console.log('[detect-pins] raw response:', cleaned.slice(0, 500));
    const pins = extractPins(cleaned, imageWidth, imageHeight);
    console.log('[detect-pins] extracted pins:', Object.keys(pins));
    return NextResponse.json({ pins });
  } catch (err) {
    console.error('[detect-pins]', err);
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
