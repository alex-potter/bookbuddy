'use client';

import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/types';

/* ── Types ────────────────────────────────────────────────────────────── */

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  charCount: number;   // characters here in latest snapshot
}

interface Edge {
  source: string;
  target: string;
  weight: number;
  color: string;
}

/* ── Constants ────────────────────────────────────────────────────────── */

// Transit-map line palette (vivid, distinct)
const LINE_COLORS = [
  '#f59e0b', // amber
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#34d399', // emerald
  '#fb7185', // rose
  '#f472b6', // pink
  '#2dd4bf', // teal
  '#818cf8', // indigo
];

const W = 780;
const H = 420;
const CX = W / 2;
const CY = H / 2;

/* ── Graph extraction ─────────────────────────────────────────────────── */

function buildGraph(snapshots: Snapshot[]): { nodes: Node[]; edges: Edge[] } {
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return { nodes: [], edges: [] };

  // Character counts at latest snapshot
  const latest = sorted[sorted.length - 1];
  const charCounts = new Map<string, number>();
  for (const c of latest.result.characters) {
    const loc = c.currentLocation?.trim();
    if (loc && loc !== 'Unknown') charCounts.set(loc, (charCounts.get(loc) ?? 0) + 1);
  }

  // Edges from character movement between consecutive snapshots
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
      const key = [oldLoc, newLoc].sort().join('\x00');
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  // Sort edges by weight descending, assign line colors
  const sortedEdges = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const edges: Edge[] = sortedEdges.map(([key, weight], i) => {
    const [source, target] = key.split('\x00');
    return { source, target, weight, color: LINE_COLORS[i % LINE_COLORS.length] };
  });

  // Nodes = all referenced locations + any with characters in latest
  const nodeIds = new Set<string>();
  for (const e of edges) { nodeIds.add(e.source); nodeIds.add(e.target); }
  for (const [loc] of charCounts.entries()) nodeIds.add(loc);

  const nodes: Node[] = Array.from(nodeIds).map((id) => ({
    id,
    x: CX + (Math.random() - 0.5) * 400,
    y: CY + (Math.random() - 0.5) * 280,
    vx: 0,
    vy: 0,
    charCount: charCounts.get(id) ?? 0,
  }));

  return { nodes, edges };
}

/* ── Physics ──────────────────────────────────────────────────────────── */

const REPULSION = 7000;
const SPRING_K = 0.045;
const SPRING_REST = 150;
const DAMPING = 0.80;
const GRAVITY = 0.007;

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
      const fx = (f * dx) / d;
      const fy = (f * dy) / d;
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
    n.x = Math.max(60, Math.min(W - 60, n.x + n.vx));
    n.y = Math.max(40, Math.min(H - 40, n.y + n.vy));
  }

  return next;
}

/* ── Subway routing ───────────────────────────────────────────────────── */

function subwayPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx >= ady) {
    const mx = x1 + Math.sign(dx) * ady;
    return `M ${x1} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
  } else {
    const my = y1 + Math.sign(dy) * adx;
    return `M ${x1} ${y1} L ${x2} ${my} L ${x2} ${y2}`;
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

  // Rebuild when snapshots change
  useEffect(() => {
    setGraph(buildGraph(snapshots));
    setSettled(false);
  }, [snapshots]);

  // Simulation — run until settled
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
        {/* Subtle grid */}
        <pattern id="sm-grid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#27272a" strokeWidth="0.5" />
        </pattern>
        {/* Glow filter for stations */}
        <filter id="sm-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Background */}
      <rect width={W} height={H} fill="#09090b" />
      <rect width={W} height={H} fill="url(#sm-grid)" />

      {/* Lines (edges) — drawn before stations so stations sit on top */}
      <g>
        {graph.edges.map((e) => {
          const s = nodeMap.get(e.source);
          const t = nodeMap.get(e.target);
          if (!s || !t) return null;
          const thick = 2.5 + 2.5 * (e.weight / maxW);
          return (
            <path
              key={`${e.source}\x00${e.target}`}
              d={subwayPath(s.x, s.y, t.x, t.y)}
              fill="none"
              stroke={e.color}
              strokeWidth={thick}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.7}
            />
          );
        })}
      </g>

      {/* Station markers + labels */}
      {graph.nodes.map((n) => {
        // Collect edge colors touching this node
        const colors = graph.edges
          .filter((e) => e.source === n.id || e.target === n.id)
          .map((e) => e.color);
        const primaryColor = colors[0] ?? '#71717a';
        const r = n.charCount > 0 ? 9 : 6;

        // Determine label side: push label away from center
        const labelRight = n.x < CX;
        const labelAnchor = labelRight ? 'start' : 'end';
        const labelX = labelRight ? n.x + r + 7 : n.x - r - 7;
        const labelY = n.y;

        return (
          <g key={n.id} filter="url(#sm-glow)">
            {/* Outer ring (line color) */}
            <circle cx={n.x} cy={n.y} r={r + 3} fill={primaryColor} opacity={0.25} />
            {/* Station circle */}
            <circle cx={n.x} cy={n.y} r={r} fill="#18181b" stroke={primaryColor} strokeWidth={2.5} />
            {/* Character count dot */}
            {n.charCount > 0 && (
              <text
                x={n.x} y={n.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="7"
                fontWeight="700"
                fill={primaryColor}
              >
                {n.charCount}
              </text>
            )}
            {/* Station name */}
            <text
              x={labelX} y={labelY - 1}
              textAnchor={labelAnchor}
              dominantBaseline="central"
              fontSize="9.5"
              fontWeight="600"
              fill="#e4e4e7"
              style={{ textShadow: '0 1px 3px #000' }}
            >
              {n.id.length > 22 ? n.id.slice(0, 20) + '…' : n.id}
            </text>
          </g>
        );
      })}

      {/* "not yet settled" shimmer hint */}
      {!settled && (
        <text x={W - 8} y={H - 8} textAnchor="end" fontSize="8" fill="#3f3f46">
          settling…
        </text>
      )}
    </svg>
  );
}
