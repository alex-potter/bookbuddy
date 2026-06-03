import { NextRequest, NextResponse } from 'next/server';
import { callLLM, resolveConfig } from '@/lib/llm';
import { getContextWindow, resolveMaxOutputTokens } from '@/lib/context-window';
import type { NarrativeArc, ParentArc } from '@/types';

const PARENT_ARC_SCHEMA = `{
  "parentArcs": [
    {
      "name": "Parent arc name",
      "children": ["child arc 1", "child arc 2"],
      "summary": "1-2 sentences about this thematic strand"
    }
  ]
}`;

function buildGroupArcsPrompt(
  bookTitle: string,
  bookAuthor: string,
  arcs: NarrativeArc[],
): string {
  const arcLines = arcs
    .map((a) => `- ${a.name} [${a.status}]: ${a.summary} (characters: ${a.characters.join(', ')})`)
    .join('\n');
  return `Given the following narrative arcs from "${bookTitle}" by ${bookAuthor}, group them into at most 5 high-level story threads (parent arcs). Each parent arc should represent a major thematic strand of the book.

ARCS:
${arcLines}

RULES:
- Create at most 5 parent arcs. Fewer is better if arcs naturally cluster.
- Every arc must belong to exactly one parent.
- Parent arc names should be concise and capture the shared theme.
- Order children within each parent by narrative importance.
- Write a 1-2 sentence summary for each parent arc describing its overarching theme.
- Use the EXACT arc names from the list above in the "children" arrays. Do not rename or paraphrase them.

Return ONLY a JSON object (no markdown fences, no explanation):
${PARENT_ARC_SCHEMA}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      bookTitle: string;
      bookAuthor: string;
      arcs: NarrativeArc[];
      _provider?: string;
      _apiKey?: string;
      _model?: string;
      _ollamaUrl?: string;
      _geminiKey?: string;
      _openaiCompatibleUrl?: string;
      _openaiCompatibleKey?: string;
      _ollamaContextLength?: number;
    };
    const { bookTitle, bookAuthor, arcs } = body;

    if (!arcs?.length) {
      return NextResponse.json({ parentArcs: [] });
    }

    const prompt = buildGroupArcsPrompt(bookTitle, bookAuthor, arcs);
    const arcNames = new Set(arcs.map((a) => a.name));
    const arcNamesLower = new Map(arcs.map((a) => [a.name.toLowerCase(), a.name]));

    const config = resolveConfig(body, { defaultAnthropicModel: 'claude-sonnet-4-20250514' });
    if (body._ollamaContextLength && config.provider === 'ollama') {
      (config as { contextLengthOverride?: number }).contextLengthOverride = body._ollamaContextLength;
    }
    const { contextWindow } = await getContextWindow(config);
    const maxTokens = resolveMaxOutputTokens({
      contextWindow,
      floor: 4096,
      inputChars: prompt.length,
    });
    const { text } = await callLLM({
      ...config,
      system: '',
      userPrompt: prompt,
      maxTokens,
      jsonMode: true,
    });

    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as { parentArcs: ParentArc[] };

    // Validate: resolve child names to exact arc names, drop unknown ones
    const assigned = new Set<string>();
    const validated: ParentArc[] = (parsed.parentArcs ?? []).map((pa) => {
      const resolvedChildren = pa.children
        .map((child) => arcNamesLower.get(child.toLowerCase()) ?? (arcNames.has(child) ? child : null))
        .filter((c): c is string => c !== null && !assigned.has(c));
      for (const c of resolvedChildren) assigned.add(c);
      return { name: pa.name, children: resolvedChildren, summary: pa.summary };
    }).filter((pa) => pa.children.length > 0);

    // Any unassigned arcs go to "Other"
    const unassigned = arcs.filter((a) => !assigned.has(a.name)).map((a) => a.name);
    if (unassigned.length > 0) {
      validated.push({ name: 'Other', children: unassigned, summary: 'Arcs not assigned to a thematic group.' });
    }

    return NextResponse.json({ parentArcs: validated });
  } catch (err) {
    console.error('[group-arcs] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to group arcs' },
      { status: 500 },
    );
  }
}
