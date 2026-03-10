'use client';

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/types';

/* ── Types ────────────────────────────────────────────────────────────── */

interface CharAvatar {
  name: string;
  status: 'alive' | 'dead' | 'unknown' | 'uncertain';
}

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  characters: CharAvatar[];
}

interface Edge {
  source: string;
  target: string;
  weight: number;
  color: string;
}

/* ── Constants ────────────────────────────────────────────────────────── */

const LINE_COLORS = [
  '#f59e0b', '#38bdf8', '#a78bfa', '#34d399',
  '#fb7185', '#f472b6', '#2dd4bf', '#818cf8',
];

const STATUS_HEX: Record<CharAvatar['status'], string> = {
  alive: '#10b981',
  dead: '#ef4444',
  unknown: '#71717a',
  uncertain: '#f59e0b',
};

const W = 780;
const H = 420;
const CX = W / 2;
const CY = H / 2;

const AVT_R = 7;       // avatar circle radius
const AVT_GAP = 2;     // gap between avatars
const AVT_STEP = AVT_R * 2 + AVT_GAP;
const MAX_SHOW = 7;    // max avatars before "+N"

/* ── Helpers ──────────────────────────────────────────────────────────── */

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** Grid positions for a cluster of `count` avatars centred on (cx, cy). */
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

/** Centre point for an avatar cluster placed `dist` from node in `angle` direction. */
function clusterCenter(nodeX: number, nodeY: number, nodeR: number, angle: number, rows: number): { cx: number; cy: number } {
  const dist = nodeR + AVT_R + 5 + ((rows - 1) / 2) * AVT_STEP;
  return {
    cx: nodeX + Math.cos(angle) * dist,
    cy: nodeY + Math.sin(angle) * dist,
  };
}

/* ── Graph extraction ─────────────────────────────────────────────────── */

function buildGraph(snapshots: Snapshot[]): { nodes: Node[]; edges: Edge[] } {
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return { nodes: [], edges: [] };

  const latest = sorted[sorted.length - 1];
  const charData = new Map<string, CharAvatar[]>();
  for (const c of latest.result.characters) {
    const loc = c.currentLocation?.trim();
    if (loc && loc !== 'Unknown') {
      if (!charData.has(loc)) charData.set(loc, []);
      charData.get(loc)!.push({ name: c.name, status: c.status });
    }
  }

  const edgeCounts = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prevMap = new Map<string, string>();
    for (const c of sorted[i - 1].result.characters) {
      if (c.currentLocation?.trim()) prevMap.set(c.name, c.currentLocation.trim());
    }
    for (const c of sorted[i].result.characters) {
      const newLoc = c.currentLocation?.trim();
      const oldLoc = prevMap.get(c.name);
      if (!newLoc || newLoc === 'Unknown' || !oldLoc || oldLoc === 'Unknown' || newLoc === oldLoc) continue;
      edgeCounts.set([oldLoc, newLoc].sort().join('\x00'), (edgeCounts.get([oldLoc, newLoc].sort().join('\x00')) ?? 0) + 1);
    }
  }

  const sortedEdges = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const edges: Edge[] = sortedEdges.map(([key, weight], i) => {
    const [source, target] = key.split('\x00');
    return { source, target, weight, color: LINE_COLORS[i % LINE_COLORS.length] };
  });

  const nodeIds = new Set<string>();
  for (const e of edges) { nodeIds.add(e.source); nodeIds.add(e.target); }
  for (const [loc] of charData.entries()) nodeIds.add(loc);

  const nodes: Node[] = Array.from(nodeIds).map((id) => ({
    id,
    x: CX + (Math.random() - 0.5) * 400,
    y: CY + (Math.random() - 0.5) * 280,
    vx: 0,
    vy: 0,
    characters: charData.get(id) ?? [],
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
    n.x = Math.max(70, Math.min(W - 70, n.x + n.vx));
    n.y = Math.max(50, Math.min(H - 50, n.y + n.vy));
  }

  return next;
}

/* ── Label placement ──────────────────────────────────────────────────── */

const LABEL_CANDIDATES = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => (d * Math.PI) / 180);

function angularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

function pickLabelAngle(node: Node, edges: Edge[], nodeMap: Map<string, Node>): number {
  const edgeAngles = edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .flatMap((e) => {
      const other = nodeMap.get(e.source === node.id ? e.target : e.source);
      return other ? [Math.atan2(other.y - node.y, other.x - node.x)] : [];
    });

  if (edgeAngles.length === 0) return Math.atan2(node.y - CY, node.x - CX);

  let bestAngle = LABEL_CANDIDATES[0];
  let bestScore = -Infinity;
  for (const cand of LABEL_CANDIDATES) {
    const score = Math.min(...edgeAngles.map((a) => angularDist(cand, a)));
    if (score > bestScore) { bestScore = score; bestAngle = cand; }
  }
  return bestAngle;
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
}

export default function SubwayMap({ snapshots }: Props) {
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] }>(() => buildGraph(snapshots));
  const [settled, setSettled] = useState(false);
  const frameRef = useRef<number>(0);

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

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const maxW = Math.max(...graph.edges.map((e) => e.weight), 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: '100%', display: 'block' }}
    >
      <defs>
        <pattern id="sm-grid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#27272a" strokeWidth="0.5" />
        </pattern>
        <filter id="sm-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <rect width={W} height={H} fill="#09090b" />
      <rect width={W} height={H} fill="url(#sm-grid)" />

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

      {/* Stations + labels + character avatars */}
      {graph.nodes.map((n) => {
        const colors = graph.edges
          .filter((e) => e.source === n.id || e.target === n.id)
          .map((e) => e.color);
        const primaryColor = colors[0] ?? '#71717a';
        const r = n.characters.length > 0 ? 9 : 6;

        const labelAngle = pickLabelAngle(n, graph.edges, nodeMap);
        const labelDist = r + 12;
        const labelX = n.x + Math.cos(labelAngle) * labelDist;
        const labelY = n.y + Math.sin(labelAngle) * labelDist;
        const labelAnchor = Math.cos(labelAngle) > 0.3 ? 'start' : Math.cos(labelAngle) < -0.3 ? 'end' : 'middle';
        const labelBaseline = Math.sin(labelAngle) > 0.3 ? 'hanging' : Math.sin(labelAngle) < -0.3 ? 'auto' : 'central';

        // Character avatars: opposite side from label
        const charAngle = labelAngle + Math.PI;
        const displayChars = n.characters.slice(0, MAX_SHOW);
        const extra = n.characters.length - MAX_SHOW;
        const showCount = displayChars.length + (extra > 0 ? 1 : 0);
        const avatarRows = Math.ceil(showCount / 3);
        const { cx: avatarCX, cy: avatarCY } = clusterCenter(n.x, n.y, r, charAngle, avatarRows);
        const positions = clusterPositions(showCount, avatarCX, avatarCY);

        return (
          <g key={n.id}>
            {/* Character avatar cluster */}
            {displayChars.map((c, i) => {
              const pos = positions[i];
              if (!pos) return null;
              const hex = STATUS_HEX[c.status];
              return (
                <g key={c.name} transform={`translate(${pos.x},${pos.y})`}>
                  <title>{c.name} ({c.status})</title>
                  <circle r={AVT_R} fill={hex + '28'} stroke={hex} strokeWidth="1.5" />
                  <text
                    textAnchor="middle" dominantBaseline="central"
                    fontSize="5.5" fontWeight="700" fill={hex}
                  >
                    {initials(c.name)}
                  </text>
                </g>
              );
            })}
            {extra > 0 && positions[MAX_SHOW] && (
              <g transform={`translate(${positions[MAX_SHOW].x},${positions[MAX_SHOW].y})`}>
                <circle r={AVT_R} fill="#27272a" stroke="#52525b" strokeWidth="1" />
                <text textAnchor="middle" dominantBaseline="central" fontSize="5" fill="#a1a1aa">
                  +{extra}
                </text>
              </g>
            )}

            {/* Station marker */}
            <g filter="url(#sm-glow)">
              <circle cx={n.x} cy={n.y} r={r + 3} fill={primaryColor} opacity={0.2} />
              <circle cx={n.x} cy={n.y} r={r} fill="#18181b" stroke={primaryColor} strokeWidth={2.5} />
            </g>

            {/* Station name */}
            <text
              x={labelX} y={labelY}
              textAnchor={labelAnchor}
              dominantBaseline={labelBaseline}
              fontSize="9.5"
              fontWeight="600"
              fill="#e4e4e7"
              style={{ textShadow: '0 1px 4px #000, 0 0 8px #000' }}
            >
              {n.id.length > 22 ? n.id.slice(0, 20) + '…' : n.id}
            </text>
          </g>
        );
      })}

      {!settled && (
        <text x={W - 8} y={H - 8} textAnchor="end" fontSize="8" fill="#3f3f46">settling…</text>
      )}
    </svg>
  );
}
