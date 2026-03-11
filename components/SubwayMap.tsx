'use client';

import { useEffect, useRef, useState } from 'react';
import type { Character, Snapshot } from '@/types';
import { withResolvedLocations } from '@/lib/resolve-locations';

/* ── Types ────────────────────────────────────────────────────────────── */

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  source: string;
  target: string;
  weight: number;
  color: string;
}

interface CharAvatar {
  name: string;
  status: Character['status'];
}

/* ── Constants ────────────────────────────────────────────────────────── */

const LINE_COLORS = [
  '#f59e0b', '#38bdf8', '#a78bfa', '#34d399',
  '#fb7185', '#f472b6', '#2dd4bf', '#818cf8',
];

const STATUS_HEX: Record<Character['status'], string> = {
  alive: '#10b981',
  dead: '#ef4444',
  unknown: '#71717a',
  uncertain: '#f59e0b',
};

const W = 1040;
const H = 580;
const CX = W / 2;
const CY = H / 2;

const AVT_R = 7;
const AVT_GAP = 2;
const AVT_STEP = AVT_R * 2 + AVT_GAP;
const MAX_SHOW = 7;

/* ── Helpers ──────────────────────────────────────────────────────────── */

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

function clusterPositions(count: number, cx: number, cy: number): Array<{ x: number; y: number }> {
  const cols = Math.min(count, 3);
  const rows = Math.ceil(count / cols);
  const positions: { x: number; y: number }[] = [];
  let idx = 0;
  for (let row = 0; row < rows && idx < count; row++) {
    const inRow = Math.min(cols, count - row * cols);
    for (let col = 0; col < inRow; col++) {
      positions.push({
        x: cx + (col - (inRow - 1) / 2) * AVT_STEP,
        y: cy + (row - (rows - 1) / 2) * AVT_STEP,
      });
      idx++;
    }
  }
  return positions;
}

function clusterCenter(nx: number, ny: number, nodeR: number, angle: number, rows: number) {
  const dist = nodeR + AVT_R + 5 + ((rows - 1) / 2) * AVT_STEP;
  return { cx: nx + Math.cos(angle) * dist, cy: ny + Math.sin(angle) * dist };
}

/* ── Graph extraction (structure only — no character data) ────────────── */

// Returns true only for real, concrete place names.
// Filters out placeholder values the LLM emits when a location is uncertain.
const FAKE_LOC_RE = /^(unknown|not specified|unspecified|unclear|n\/a|none|various|travelling|traveling|en route|in transit)/i;
function isRealLocation(loc: string | undefined): loc is string {
  if (!loc) return false;
  const t = loc.trim();
  return t.length > 0 && !FAKE_LOC_RE.test(t);
}

function buildGraph(snapshots: Snapshot[]): { nodes: Node[]; edges: Edge[] } {
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return { nodes: [], edges: [] };

  // Collect all real location names ever seen
  const allLocs = new Set<string>();
  for (const snap of sorted) {
    for (const c of snap.result.characters) {
      const loc = c.currentLocation?.trim();
      if (isRealLocation(loc)) allLocs.add(loc);
    }
  }

  // Edges from character movement between consecutive snapshots
  const edgeCounts = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prevMap = new Map<string, string>();
    for (const c of sorted[i - 1].result.characters) {
      const loc = c.currentLocation?.trim();
      if (isRealLocation(loc)) prevMap.set(c.name, loc);
    }
    for (const c of sorted[i].result.characters) {
      const newLoc = c.currentLocation?.trim();
      const oldLoc = prevMap.get(c.name);
      if (!isRealLocation(newLoc) || !isRealLocation(oldLoc) || newLoc === oldLoc) continue;
      const key = [oldLoc, newLoc].sort().join('\x00');
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  const sortedEdges = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const edges: Edge[] = sortedEdges.map(([key, weight], i) => {
    const [source, target] = key.split('\x00');
    return { source, target, weight, color: LINE_COLORS[i % LINE_COLORS.length] };
  });

  // Nodes = locations with edges + any location seen in any snapshot
  const nodeIds = new Set<string>();
  for (const e of edges) { nodeIds.add(e.source); nodeIds.add(e.target); }
  for (const loc of allLocs) nodeIds.add(loc);

  const nodes: Node[] = Array.from(nodeIds).map((id) => ({
    id,
    x: CX + (Math.random() - 0.5) * 700,
    y: CY + (Math.random() - 0.5) * 450,
    vx: 0,
    vy: 0,
  }));

  return { nodes, edges };
}

/* ── Physics ──────────────────────────────────────────────────────────── */

const REPULSION = 10000;
const SPRING_K = 0.04;
const SPRING_REST = 180;
const DAMPING = 0.80;
const GRAVITY = 0.006;

function tick(nodes: Node[], edges: Edge[]): Node[] {
  const next = nodes.map((n) => ({ ...n }));
  const idx = new Map(next.map((n, i) => [n.id, i]));

  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const dx = next[j].x - next[i].x;
      const dy = next[j].y - next[i].y;
      const d2 = Math.max(dx * dx + dy * dy, 100);
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const fx = (f * dx) / d; const fy = (f * dy) / d;
      next[i].vx -= fx; next[i].vy -= fy;
      next[j].vx += fx; next[j].vy += fy;
    }
  }

  for (const e of edges) {
    const si = idx.get(e.source); const ti = idx.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const dx = next[ti].x - next[si].x;
    const dy = next[ti].y - next[si].y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
    const f = SPRING_K * (d - SPRING_REST);
    const fx = (f * dx) / d; const fy = (f * dy) / d;
    next[si].vx += fx; next[si].vy += fy;
    next[ti].vx -= fx; next[ti].vy -= fy;
  }

  for (const n of next) {
    n.vx += (CX - n.x) * GRAVITY;
    n.vy += (CY - n.y) * GRAVITY;
    n.vx *= DAMPING; n.vy *= DAMPING;
    n.x = Math.max(110, Math.min(W - 110, n.x + n.vx));
    n.y = Math.max(70, Math.min(H - 70, n.y + n.vy));
  }

  return next;
}

/* ── Label placement ──────────────────────────────────────────────────── */

// 32 candidates at 11.25° intervals for fine-grained placement
const LABEL_CANDIDATES = Array.from({ length: 32 }, (_, i) => (i * 11.25 * Math.PI) / 180);
const NEARBY_RADIUS = 200; // px — nearby nodes also act as label obstacles

const LABEL_R_OFFSET = 16;  // px from node edge to label anchor
const LABEL_FONT = 9.5;
const LABEL_CHAR_W = LABEL_FONT * 0.57; // approximate SVG text char width
const LINE_HEIGHT = LABEL_FONT * 1.45;
const MAX_LINE_CHARS = 20;
const MAX_LINES = 3;

function angularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

function pickLabelAngle(node: Node, edges: Edge[], allNodes: Node[]): number {
  // Edge directions are hard obstacles
  const edgeAngles = edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .flatMap((e) => {
      const otherId = e.source === node.id ? e.target : e.source;
      const other = allNodes.find((n) => n.id === otherId);
      return other ? [Math.atan2(other.y - node.y, other.x - node.x)] : [];
    });

  // Nearby (non-connected) nodes also repel labels, weighted by proximity
  const nearbyAngles: { angle: number; weight: number }[] = [];
  const connectedIds = new Set(
    edges
      .filter((e) => e.source === node.id || e.target === node.id)
      .map((e) => (e.source === node.id ? e.target : e.source)),
  );
  for (const other of allNodes) {
    if (other.id === node.id || connectedIds.has(other.id)) continue;
    const dx = other.x - node.x;
    const dy = other.y - node.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < NEARBY_RADIUS) {
      nearbyAngles.push({ angle: Math.atan2(dy, dx), weight: 1 - dist / NEARBY_RADIUS });
    }
  }

  const obstacles: number[] = [...edgeAngles];
  for (const { angle, weight } of nearbyAngles) {
    const copies = Math.round(1 + weight * 3);
    for (let k = 0; k < copies; k++) obstacles.push(angle);
  }

  if (obstacles.length === 0) return Math.atan2(node.y - CY, node.x - CX);

  let bestAngle = LABEL_CANDIDATES[0];
  let bestScore = -Infinity;
  for (const cand of LABEL_CANDIDATES) {
    const score = Math.min(...obstacles.map((a) => angularDist(cand, a)));
    if (score > bestScore) { bestScore = score; bestAngle = cand; }
  }
  return bestAngle;
}

/* ── Label bbox helpers ───────────────────────────────────────────────── */

type LabelInfo = {
  lx: number; ly: number;
  anchor: 'start' | 'end' | 'middle';
  baseline: 'hanging' | 'auto' | 'central';
};

function angleToLabel(node: Node, r: number, angle: number): LabelInfo {
  const lx = node.x + Math.cos(angle) * (r + LABEL_R_OFFSET);
  const ly = node.y + Math.sin(angle) * (r + LABEL_R_OFFSET);
  const anchor = (Math.cos(angle) > 0.3 ? 'start' : Math.cos(angle) < -0.3 ? 'end' : 'middle') as 'start' | 'end' | 'middle';
  const baseline = (Math.sin(angle) > 0.3 ? 'hanging' : Math.sin(angle) < -0.3 ? 'auto' : 'central') as 'hanging' | 'auto' | 'central';
  return { lx, ly, anchor, baseline };
}

/** Break a location name into wrapped lines, max MAX_LINES × MAX_LINE_CHARS. */
function wrapLabel(id: string): string[] {
  const words = id.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (cur.length === 0) {
      cur = word;
    } else if (cur.length + 1 + word.length <= MAX_LINE_CHARS) {
      cur += ' ' + word;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > MAX_LINES) {
    lines.splice(MAX_LINES);
    const last = lines[MAX_LINES - 1];
    if (last.length > MAX_LINE_CHARS - 1) lines[MAX_LINES - 1] = last.slice(0, MAX_LINE_CHARS - 1) + '…';
  }
  return lines;
}

/** Top-left y of a multi-line text block given its anchor baseline. */
function blockTopY(ly: number, baseline: 'hanging' | 'auto' | 'central', lineCount: number): number {
  const totalH = lineCount * LINE_HEIGHT;
  if (baseline === 'auto') return ly - totalH;
  if (baseline === 'central') return ly - totalH / 2;
  return ly; // hanging
}

function labelBbox(info: LabelInfo, lines: string[]) {
  const w = Math.max(...lines.map((l) => l.length)) * LABEL_CHAR_W + 4;
  const h = lines.length * LINE_HEIGHT + 2;
  let x = info.lx;
  const y = blockTopY(info.ly, info.baseline, lines.length);
  if (info.anchor === 'end') x -= w;
  else if (info.anchor === 'middle') x -= w / 2;
  return { x, y, w, h };
}

function bboxOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/* ── Subway routing ───────────────────────────────────────────────────── */

function subwayPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1; const dy = y2 - y1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return `M ${x1} ${y1} L ${x1 + Math.sign(dx) * Math.abs(dy)} ${y2} L ${x2} ${y2}`;
  } else {
    return `M ${x1} ${y1} L ${x2} ${y1 + Math.sign(dy) * Math.abs(dx)} L ${x2} ${y2}`;
  }
}

/* ── Component ────────────────────────────────────────────────────────── */

interface Props {
  snapshots: Snapshot[];
  currentCharacters?: Character[];  // characters at the currently viewed snapshot
}

export default function SubwayMap({ snapshots, currentCharacters = [] }: Props) {
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] }>(() => buildGraph(snapshots));
  const [settled, setSettled] = useState(false);
  const frameRef = useRef<number>(0);

  // Rebuild graph structure when snapshots change (new chapters analyzed)
  useEffect(() => {
    setGraph(buildGraph(snapshots));
    setSettled(false);
  }, [snapshots]);

  useEffect(() => {
    if (settled) return;
    let count = 0;
    const MAX = 400;
    function loop() {
      setGraph((prev) => {
        const next = tick(prev.nodes, prev.edges);
        const maxV = next.reduce((m, n) => Math.max(m, Math.abs(n.vx) + Math.abs(n.vy)), 0);
        if (maxV < 0.08 || count >= MAX) setSettled(true);
        count++;
        return { nodes: next, edges: prev.edges };
      });
      if (count < MAX) frameRef.current = requestAnimationFrame(loop);
    }
    frameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRef.current);
  }, [settled]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 gap-2">
        <span className="text-3xl opacity-20">🗺️</span>
        <p className="text-xs text-zinc-600">Analyze chapters to populate the map</p>
      </div>
    );
  }

  // Build live character→location map from currentCharacters (updates with snapshot nav).
  // Characters with unknown locations fall back to their last confirmed location.
  const resolvedCharacters = withResolvedLocations(currentCharacters, snapshots);
  const liveByLoc = new Map<string, CharAvatar[]>();
  for (const c of resolvedCharacters) {
    const loc = c.currentLocation?.trim();
    if (isRealLocation(loc)) {
      if (!liveByLoc.has(loc)) liveByLoc.set(loc, []);
      liveByLoc.get(loc)!.push({ name: c.name, status: c.status });
    }
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const maxW = Math.max(...graph.edges.map((e) => e.weight), 1);

  // ── Phase 1: collision-aware label placement ──────────────────────────
  // Nodes with more connections get label placement priority.
  const nodeDegree = new Map<string, number>();
  for (const e of graph.edges) {
    nodeDegree.set(e.source, (nodeDegree.get(e.source) ?? 0) + 1);
    nodeDegree.set(e.target, (nodeDegree.get(e.target) ?? 0) + 1);
  }
  const sortedForLabels = [...graph.nodes].sort(
    (a, b) => (nodeDegree.get(b.id) ?? 0) - (nodeDegree.get(a.id) ?? 0),
  );

  // Pre-seed with node circle bboxes so labels won't be placed over any circle
  const NODE_PAD = 4;
  const placedBoxes: Array<{ x: number; y: number; w: number; h: number }> = graph.nodes.map((n) => {
    const nr = (liveByLoc.get(n.id)?.length ?? 0) > 0 ? 9 : 6;
    const half = nr + NODE_PAD;
    return { x: n.x - half, y: n.y - half, w: half * 2, h: half * 2 };
  });
  const resolvedAngles = new Map<string, number>();

  for (const n of sortedForLabels) {
    const r = (liveByLoc.get(n.id)?.length ?? 0) > 0 ? 9 : 6;
    const lines = wrapLabel(n.id);
    const preferred = pickLabelAngle(n, graph.edges, graph.nodes);
    // Try candidates closest to preferred first; pick the one with fewest bbox overlaps
    const ordered = [...LABEL_CANDIDATES].sort((a, b) => angularDist(a, preferred) - angularDist(b, preferred));
    let chosenAngle = preferred;
    let bestOverlaps = Infinity;
    for (const angle of ordered) {
      const info = angleToLabel(n, r, angle);
      const box = labelBbox(info, lines);
      const oc = placedBoxes.filter((b) => bboxOverlap(box, b)).length;
      if (oc < bestOverlaps) {
        bestOverlaps = oc;
        chosenAngle = angle;
        if (oc === 0) break;
      }
    }
    const chosen = angleToLabel(n, r, chosenAngle);
    placedBoxes.push(labelBbox(chosen, lines));
    resolvedAngles.set(n.id, chosenAngle);
  }

  // ── Phase 2: build render data using resolved label angles ─────────────
  // Avatars are rendered as a flat list (keyed by char name) so the same DOM element
  // persists across snapshot changes — CSS transition then animates the position change.
  const charPositions = new Map<string, { x: number; y: number; status: CharAvatar['status'] }>();
  const overflowBadges: Array<{ x: number; y: number; count: number }> = [];

  const nodeData = graph.nodes.map((n) => {
    const colors = graph.edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => e.color);
    const primaryColor = colors[0] ?? '#71717a';
    const chars = liveByLoc.get(n.id) ?? [];
    const r = chars.length > 0 ? 9 : 6;
    const lines = wrapLabel(n.id);

    const labelAngle = resolvedAngles.get(n.id) ?? pickLabelAngle(n, graph.edges, graph.nodes);
    const { lx: labelX, ly: labelY, anchor: labelAnchor, baseline: labelBaseline } = angleToLabel(n, r, labelAngle);

    // Avatar cluster on opposite side of label
    const charAngle = labelAngle + Math.PI;
    const displayChars = chars.slice(0, MAX_SHOW);
    const extra = chars.length - MAX_SHOW;
    const showCount = displayChars.length + (extra > 0 ? 1 : 0);
    const avatarRows = Math.ceil(Math.max(showCount, 1) / 3);
    const { cx: aCX, cy: aCY } = clusterCenter(n.x, n.y, r, charAngle, avatarRows);
    const positions = clusterPositions(showCount, aCX, aCY);

    displayChars.forEach((c, i) => {
      if (positions[i]) charPositions.set(c.name, { x: positions[i].x, y: positions[i].y, status: c.status });
    });
    if (extra > 0 && positions[MAX_SHOW]) {
      overflowBadges.push({ x: positions[MAX_SHOW].x, y: positions[MAX_SHOW].y, count: extra });
    }

    return { n, primaryColor, r, lines, labelX, labelY, labelAnchor, labelBaseline };
  });

  // Grid as a CSS background so it covers the full container, not just the SVG viewBox
  const gridBg = `url("data:image/svg+xml,%3Csvg width='30' height='30' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M 30 0 L 0 0 0 30' fill='none' stroke='%2327272a' stroke-width='0.5'/%3E%3C/svg%3E")`;

  return (
    <div className="relative w-full h-full bg-zinc-950" style={{ backgroundImage: gridBg }}>
      {/* Spinner shown while physics settles */}
      {!settled && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2">
          <div className="w-5 h-5 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
          <p className="text-[10px] text-zinc-600">Laying out map…</p>
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: '100%', display: 'block', opacity: settled ? 1 : 0, transition: 'opacity 0.4s ease' }}
      >
      <defs>
        <filter id="sm-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Transit lines */}
      <g>
        {graph.edges.map((e) => {
          const s = nodeMap.get(e.source);
          const t = nodeMap.get(e.target);
          if (!s || !t) return null;
          return (
            <path
              key={`${e.source}\x00${e.target}`}
              d={subwayPath(s.x, s.y, t.x, t.y)}
              fill="none"
              stroke={e.color}
              strokeWidth={2.5 + 2.5 * (e.weight / maxW)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.65}
            />
          );
        })}
      </g>

      {/* Station circles — rendered before labels so labels always appear on top */}
      {nodeData.map(({ n, primaryColor, r }) => (
        <g key={n.id} filter="url(#sm-glow)">
          <circle cx={n.x} cy={n.y} r={r + 3} fill={primaryColor} opacity={0.2} />
          <circle cx={n.x} cy={n.y} r={r} fill="#18181b" stroke={primaryColor} strokeWidth={2.5} />
        </g>
      ))}

      {/* Station labels — rendered after all circles so no circle obscures a label */}
      {nodeData.map(({ n, lines, labelX, labelY, labelAnchor, labelBaseline }) => {
        const startY = blockTopY(labelY, labelBaseline, lines.length);
        return (
          <text
            key={n.id}
            x={labelX} y={startY}
            textAnchor={labelAnchor} dominantBaseline="hanging"
            fontSize={LABEL_FONT} fontWeight="600" fill="#e4e4e7"
            style={{ textShadow: '0 1px 4px #000, 0 0 8px #000' }}
          >
            {lines.map((line, i) => (
              <tspan key={i} x={labelX} dy={i === 0 ? 0 : LINE_HEIGHT}>{line}</tspan>
            ))}
          </text>
        );
      })}

      {/* Overflow +N badges (static per station, no transition needed) */}
      {overflowBadges.map(({ x, y, count }, i) => (
        <g key={`overflow-${i}`} transform={`translate(${x},${y})`}>
          <circle r={AVT_R} fill="#27272a" stroke="#52525b" strokeWidth="1" />
          <text textAnchor="middle" dominantBaseline="central" fontSize="5" fill="#a1a1aa">+{count}</text>
        </g>
      ))}

      {/* Character avatars — flat list keyed by name so the same DOM element persists
          across snapshot changes, letting CSS transition animate the position. */}
      {Array.from(charPositions.entries()).map(([name, { x, y, status }]) => {
        const hex = STATUS_HEX[status];
        return (
          <g
            key={name}
            style={{
              transform: `translate(${x}px, ${y}px)`,
              transition: settled ? 'transform 0.65s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
            }}
          >
            <title>{name} ({status})</title>
            <circle r={AVT_R} fill={hex + '28'} stroke={hex} strokeWidth="1.5" />
            <text textAnchor="middle" dominantBaseline="central" fontSize="5.5" fontWeight="700" fill={hex}>
              {initials(name)}
            </text>
          </g>
        );
      })}

    </svg>
    </div>
  );
}
