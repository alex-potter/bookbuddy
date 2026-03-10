import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import type { LocationPin } from '@/types';

const ollamaAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });


const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function buildPrompt(locations: string[]): string {
  return `This is a fantasy/story map image. Your task is to locate specific place names that are printed as visible text labels directly on the map image, and return their positions as percentages of the image dimensions.

Coordinate system:
- x = 0 means the LEFT edge of the image, x = 100 means the RIGHT edge
- y = 0 means the TOP edge of the image, y = 100 means the BOTTOM edge
- Example: a label in the upper-left quarter might be x=20, y=15
- Example: a label near the bottom-center might be x=50, y=85

Return ONLY a valid JSON object with no prose, no markdown, no explanation:
{"pins": {"Exact Label Text": {"x": 34.5, "y": 61.2}, ...}}

Strict rules:
- ONLY include a location if you can clearly read its name as printed text somewhere on the map image.
- Do NOT guess or estimate for names you cannot see written on the map.
- Do NOT include a location if it is not visibly labelled.
- Partial matches are acceptable (e.g. "Tar Valon" matches a label reading "Tar Valon" or "TAR VALON").
- x and y must point to the center of the text label itself, not the territory it represents.
- If none of the locations are labelled on the map, return {"pins": {}}.

Locations to find (look for these as written text on the map):
${locations.map((l) => `- ${l}`).join('\n')}`;
}

function extractPins(raw: string): Record<string, LocationPin> {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { pins?: Record<string, LocationPin> };
    const pins: Record<string, LocationPin> = {};
    for (const [name, pos] of Object.entries(parsed.pins ?? {})) {
      const x = Math.max(0, Math.min(100, Number(pos.x)));
      const y = Math.max(0, Math.min(100, Number(pos.y)));
      if (!isNaN(x) && !isNaN(y)) pins[name] = { x, y };
    }
    return pins;
  } catch {
    return {};
  }
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
      max_tokens: 1024,
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
    max_tokens: 1024,
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

    console.log('[detect-pins] raw response:', raw.slice(0, 500));
    const pins = extractPins(raw);
    console.log('[detect-pins] extracted pins:', Object.keys(pins));
    return NextResponse.json({ pins });
  } catch (err) {
    console.error('[detect-pins]', err);
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
