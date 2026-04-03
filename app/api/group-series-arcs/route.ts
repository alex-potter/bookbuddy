import { NextRequest, NextResponse } from 'next/server';
import { callLLM, resolveConfig } from '@/lib/llm';
import type { ParentArc } from '@/types';

const SERIES_ARC_SCHEMA = `{
  "seriesArcs": [
    {
      "name": "Series-wide theme name",
      "children": ["per-book parent arc 1", "per-book parent arc 2"],
      "summary": "1-2 sentences about this cross-book narrative thread"
    }
  ]
}`;

function buildGroupSeriesArcsPrompt(
  bookTitle: string,
  bookAuthor: string,
  bookArcs: Array<{ bookTitle: string; parentArcs: ParentArc[] }>,
): string {
  const sections = bookArcs.map(({ bookTitle: bt, parentArcs }) => {
    const arcLines = parentArcs
      .map((pa) => `  - ${pa.name}: ${pa.summary} (contains: ${pa.children.join(', ')})`)
      .join('\n');
    return `${bt}:\n${arcLines}`;
  }).join('\n\n');

  return `Given the following per-book arc groupings from the series "${bookTitle}" by ${bookAuthor}, identify the major cross-book narrative threads that span multiple books.

PER-BOOK ARC GROUPINGS:
${sections}

RULES:
- Create at most 7 series-wide themes. Fewer is better if themes naturally cluster.
- Each series theme should span at least 2 books.
- Use the EXACT per-book parent arc names in the "children" arrays.
- A per-book parent arc can belong to multiple series themes if it genuinely spans multiple threads.
- Per-book arcs that only appear in one book and don't connect to broader themes can be omitted.
- Write a 1-2 sentence summary for each series theme describing the overarching cross-book narrative.

Return ONLY a JSON object (no markdown fences, no explanation):
${SERIES_ARC_SCHEMA}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      bookTitle: string;
      bookAuthor: string;
      bookArcs: Array<{ bookTitle: string; parentArcs: ParentArc[] }>;
      _provider?: string;
      _apiKey?: string;
      _model?: string;
      _ollamaUrl?: string;
      _geminiKey?: string;
      _openaiCompatibleUrl?: string;
      _openaiCompatibleKey?: string;
    };
    const { bookTitle, bookAuthor, bookArcs } = body;

    const booksWithArcs = bookArcs.filter((ba) => ba.parentArcs.length > 0);
    if (booksWithArcs.length < 2) {
      return NextResponse.json({ seriesArcs: [] });
    }

    const prompt = buildGroupSeriesArcsPrompt(bookTitle, bookAuthor, booksWithArcs);
    const allArcNames = new Set(booksWithArcs.flatMap((ba) => ba.parentArcs.map((pa) => pa.name)));
    const arcNamesLower = new Map<string, string>();
    for (const name of allArcNames) arcNamesLower.set(name.toLowerCase(), name);

    const config = resolveConfig(body, { defaultAnthropicModel: 'claude-sonnet-4-20250514' });
    const { text } = await callLLM({
      ...config,
      system: '',
      userPrompt: prompt,
      maxTokens: 4096,
      jsonMode: true,
    });

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as { seriesArcs: ParentArc[] };

    const validated: ParentArc[] = (parsed.seriesArcs ?? []).map((sa) => {
      const resolvedChildren = sa.children
        .map((child) => arcNamesLower.get(child.toLowerCase()) ?? (allArcNames.has(child) ? child : null))
        .filter((c): c is string => c !== null);
      return { name: sa.name, children: resolvedChildren, summary: sa.summary };
    }).filter((sa) => sa.children.length > 0);

    return NextResponse.json({ seriesArcs: validated });
  } catch (err) {
    console.error('[group-series-arcs] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to group series arcs' },
      { status: 500 },
    );
  }
}
