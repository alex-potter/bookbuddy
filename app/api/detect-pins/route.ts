import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import type { LocationPin } from '@/types';

const ollamaAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });


const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function buildPrompt(locations: string[]): string {
  return `Look at this map image and find as many of the listed place names as you can. The names are printed as text labels directly on the map.

For each name you can find, record the position of its text label as a percentage of the image size:
- x: 0 = left edge, 100 = right edge
- y: 0 = top edge, 100 = bottom edge

Examples: upper-left label → x=15, y=10 | bottom-center label → x=50, y=85

Rules:
- Include every name from the list that you can find written on the map, even if the text is small or stylised.
- x and y should point to the center of the text label itself.
- Case-insensitive matching is fine (e.g. "TAR VALON" matches "Tar Valon").
- Only omit a name if you genuinely cannot find it anywhere on the map.
- If you cannot find any of the names, return {"pins": {}}.

Return ONLY this JSON (no markdown fences, no explanation):
{"pins": {"Place Name": {"x": 34.5, "y": 61.2}, ...}}

Place names to find:
${locations.map((l) => `- ${l}`).join('\n')}`;
}

function extractPins(raw: string): Record<string, LocationPin> {
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

  // Normalize coordinates: if any value exceeds 100 the model returned pixel coords
  const allX = Object.values(rawPins).map((p) => p.x);
  const allY = Object.values(rawPins).map((p) => p.y);
  const maxX = Math.max(...allX);
  const maxY = Math.max(...allY);
  const needsNorm = maxX > 100 || maxY > 100;

  const pins: Record<string, LocationPin> = {};
  for (const [name, pos] of Object.entries(rawPins)) {
    const x = needsNorm ? (pos.x / maxX) * 100 : pos.x;
    const y = needsNorm ? (pos.y / maxY) * 100 : pos.y;
    pins[name] = {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
    };
  }
  return pins;
}

async function callLocal(imageDataUrl: string, prompt: string): Promise<string> {
  const baseUrl = process.env.LOCAL_MODEL_URL ?? 'http://localhost:11434/v1';
  const model = process.env.LOCAL_VISION_MODEL_NAME ?? 'qwen2.5vl:7b';

  const res = await undiciFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    dispatcher: ollamaAgent,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  } as Parameters<typeof undiciFetch>[1]);

  if (!res.ok) throw new Error(`Local model error (${res.status}): ${await res.text()}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in local model response.');
  return text;
}

async function callAnthropic(
  base64Data: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
  prompt: string,
): Promise<string> {
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  return response.content[0].type === 'text' ? response.content[0].text.trim() : '';
}

export async function POST(req: NextRequest) {
  try {
    const { imageDataUrl, locations } = (await req.json()) as {
      imageDataUrl: string;
      locations: string[];
    };

    if (!imageDataUrl || !locations?.length) {
      return NextResponse.json({ error: 'Missing imageDataUrl or locations' }, { status: 400 });
    }

    const commaIdx = imageDataUrl.indexOf(',');
    const header = imageDataUrl.slice(0, commaIdx);
    const base64Data = imageDataUrl.slice(commaIdx + 1);
    const rawType = header.match(/data:([^;]+)/)?.[1] ?? 'image/png';
    const mediaType = SUPPORTED_TYPES.has(rawType)
      ? (rawType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
      : 'image/png';

    const prompt = buildPrompt(locations);
    const useLocal = process.env.USE_LOCAL_MODEL === 'true';

    const raw = useLocal
      ? await callLocal(imageDataUrl, prompt)
      : await callAnthropic(base64Data, mediaType, prompt);

    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    console.log('[detect-pins] raw response:', cleaned.slice(0, 500));
    const pins = extractPins(cleaned);
    console.log('[detect-pins] extracted pins:', Object.keys(pins));
    return NextResponse.json({ pins });
  } catch (err) {
    console.error('[detect-pins]', err);
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
