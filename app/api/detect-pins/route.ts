import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { LocationPin } from '@/types';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function buildPrompt(locations: string[]): string {
  return `This is a map image. I have a list of location names that characters in a story occupy. Your job is to find each location name as written text on the map and return its approximate center position.

Return ONLY a JSON object — no prose, no markdown fences. Schema:
{"pins": {"Location Name": {"x": 45.2, "y": 23.1}, ...}}

Where x and y are percentages of the image width and height respectively (0 = left/top, 100 = right/bottom).

Rules:
- Only include locations you can actually read on the map as visible text labels.
- If a name does not appear on the map, omit it entirely.
- Partial matches are fine (e.g. "The Eyrie" matches a label that says "Eyrie").
- x and y should point to the center of the text label.

Locations to find:
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
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
  }).finally(() => clearTimeout(timer));

  if (!res.ok) throw new Error(`Local model error (${res.status}): ${await res.text()}`);
  const data = await res.json();
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

    return NextResponse.json({ pins: extractPins(raw) });
  } catch (err) {
    console.error('[detect-pins]', err);
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
