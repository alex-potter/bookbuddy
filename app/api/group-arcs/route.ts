import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { NarrativeArc, ParentArc } from '@/types';

const anthropic = new Anthropic();

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
    const body = await req.json();
    const { bookTitle, bookAuthor, arcs, _provider, _apiKey, _model, _ollamaUrl } = body as {
      bookTitle: string;
      bookAuthor: string;
      arcs: NarrativeArc[];
      _provider?: string;
      _apiKey?: string;
      _model?: string;
      _ollamaUrl?: string;
    };

    if (!arcs?.length) {
      return NextResponse.json({ parentArcs: [] });
    }

    const prompt = buildGroupArcsPrompt(bookTitle, bookAuthor, arcs);
    const arcNames = new Set(arcs.map((a) => a.name));
    const arcNamesLower = new Map(arcs.map((a) => [a.name.toLowerCase(), a.name]));

    let text: string;

    if (_provider === 'ollama') {
      const ollamaUrl = _ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
      const model = _model || 'llama3';
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      const data = await res.json();
      text = data.response ?? '';
    } else {
      const apiKey = _apiKey || process.env.ANTHROPIC_API_KEY;
      const model = _model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
      const client = apiKey && apiKey !== process.env.ANTHROPIC_API_KEY
        ? new Anthropic({ apiKey })
        : anthropic;
      const msg = await client.messages.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });
      text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }

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
