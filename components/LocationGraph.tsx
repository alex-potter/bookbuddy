'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Character, Snapshot } from '@/types';
import { withResolvedLocations } from '@/lib/resolve-locations';

interface CharAvatar {
  name: string;
  status: Character['status'];
}

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
  weight: number; // total character transitions
}

interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

function buildGraph(snapshots: Snapshot[]): GraphData {
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);

  // Build edges from character movements between consecutive snapshots
  const edgeCounts = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    const prevLocMap = new Map<string, string>();
    for (const c of prev.result.characters) {
      if (c.currentLocation?.trim()) prevLocMap.set(c.name, c.currentLocation.trim());
    }

    for (const c of curr.result.characters) {
      const newLoc = c.currentLocation?.trim();
      const oldLoc = prevLocMap.get(c.name);
      if (!newLoc || newLoc === 'Unknown' || !oldLoc || oldLoc === 'Unknown') continue;
      if (newLoc === oldLoc) continue;

      const key = [oldLoc, newLoc].sort().join('|||');
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  // Also add edges for locations that co-occur (characters at same place) to keep graph connected
  // Only use movement edges — purely movement-based is better for story flow

  // Build final edges
  const edges: Edge[] = [];
  for (const [key, weight] of edgeCounts.entries()) {
    const [source, target] = key.split('|||');
    edges.push({ source, target, weight });
  }

  // Collect all nodes referenced in edges + all locations ever seen
  const usedNodes = new Set<string>();
  for (const e of edges) { usedNodes.add(e.source); usedNodes.add(e.target); }
  for (const snap of sorted) {
    for (const c of snap.result.characters) {
      const loc = c.currentLocation?.trim();
      if (loc && loc !== 'Unknown') usedNodes.add(loc);
    }
  }

  const nodes: Node[] = Array.from(usedNodes).map((id) => ({
    id,
    x: Math.random() * 600 + 100,
    y: Math.random() * 400 + 100,
    vx: 0,
    vy: 0,
  }));

  return { nodes, edges };
}

const REPULSION = 8000;
const SPRING_K = 0.04;
const SPRING_REST = 140;
const DAMPING = 0.82;
const CENTER_GRAVITY = 0.006;
const CENTER_X = 400;
const CENTER_Y = 300;
const DT = 1;

function tick(nodes: Node[], edges: Edge[]): Node[] {
  const next = nodes.map((n) => ({ ...n }));
  const idx = new Map(next.map((n, i) => [n.id, i]));

  // Repulsion
  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const dx = next[j].x - next[i].x;
      const dy = next[j].y - next[i].y;
      const dist2 = Math.max(dx * dx + dy * dy, 100);
      const dist = Math.sqrt(dist2);
      const force = REPULSION / dist2;
      const fx = (force * dx) / dist;
      const fy = (force * dy) / dist;
      next[i].vx -= fx;
      next[i].vy -= fy;
      next[j].vx += fx;
      next[j].vy += fy;
    }
  }

  // Spring attraction
  for (const e of edges) {
    const si = idx.get(e.source);
    const ti = idx.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const dx = next[ti].x - next[si].x;
    const dy = next[ti].y - next[si].y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
    const stretch = dist - SPRING_REST;
    const force = SPRING_K * stretch;
    const fx = (force * dx) / dist;
    const fy = (force * dy) / dist;
    next[si].vx += fx;
    next[si].vy += fy;
    next[ti].vx -= fx;
    next[ti].vy -= fy;
  }

  // Center gravity + integrate
  for (const n of next) {
    n.vx += (CENTER_X - n.x) * CENTER_GRAVITY;
    n.vy += (CENTER_Y - n.y) * CENTER_GRAVITY;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx * DT;
    n.y += n.vy * DT;
  }

  return next;
}

const STATUS_HEX: Record<CharAvatar['status'], string> = {
  alive: '#10b981',
  dead: '#ef4444',
  unknown: '#71717a',
  uncertain: '#f59e0b',
};

function charInitials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

const PALETTE_SIZE = 8;

function nodeColor(name: string) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(hash) % PALETTE_SIZE;
}

// Label placement: pick the angle (8 candidates) furthest from all connected edge directions
const LABEL_CANDS = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => (d * Math.PI) / 180);

function angDist(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

function pickAngle(nodeId: string, nodes: { id: string; x: number; y: number }[], edges: { source: string; target: string }[]): number {
  const self = nodes.find((n) => n.id === nodeId);
  if (!self) return Math.PI / 2;
  const edgeAngles = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .flatMap((e) => {
      const other = nodes.find((n) => n.id === (e.source === nodeId ? e.target : e.source));
      return other ? [Math.atan2(other.y - self.y, other.x - self.x)] : [];
    });
  if (edgeAngles.length === 0) return Math.PI / 2; // default: below
  let best = LABEL_CANDS[0]; let bestScore = -Infinity;
  for (const cand of LABEL_CANDS) {
    const score = Math.min(...edgeAngles.map((a) => angDist(cand, a)));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

interface Props {
  snapshots: Snapshot[];
  currentCharacters?: Character[];
}

export default function LocationGraph({ snapshots, currentCharacters = [] }: Props) {
  const [graph, setGraph] = useState<GraphData>(() => buildGraph(snapshots));
  const [running, setRunning] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<number>(0);
  const nodesRef = useRef(graph.nodes);
  const edgesRef = useRef(graph.edges);
  nodesRef.current = graph.nodes;
  edgesRef.current = graph.edges;

  // Rebuild when snapshots change
  useEffect(() => {
    const g = buildGraph(snapshots);
    setGraph(g);
    setRunning(true);
  }, [snapshots]);

  // Simulation loop
  useEffect(() => {
    if (!running) return;
    let frameCount = 0;
    const MAX_FRAMES = 300;

    function loop() {
      setGraph((prev) => {
        const next = tick(prev.nodes, prev.edges);
        // Check if settled
        const maxV = Math.max(...next.map((n) => Math.abs(n.vx) + Math.abs(n.vy)));
        if (maxV < 0.05 || frameCount >= MAX_FRAMES) {
          setRunning(false);
        }
        frameCount++;
        return { nodes: next, edges: prev.edges };
      });
      if (frameCount < MAX_FRAMES) {
        frameRef.current = requestAnimationFrame(loop);
      }
    }

    frameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRef.current);
  }, [running]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    setDragging(nodeId);
    setRunning(false);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = 800 / rect.width;
    const scaleY = 600 / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    setGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => n.id === dragging ? { ...n, x, y, vx: 0, vy: 0 } : n),
    }));
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      setDragging(null);
      setRunning(true);
    }
  }, [dragging]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-600 text-sm">
        No location data yet — analyze some chapters first.
      </div>
    );
  }

  // Build live character→location map from currentCharacters.
  // Characters with unknown locations fall back to their last confirmed location.
  const resolvedCharacters = withResolvedLocations(currentCharacters, snapshots);
  const liveByLoc = new Map<string, CharAvatar[]>();
  for (const c of resolvedCharacters) {
    const loc = c.currentLocation?.trim();
    if (loc && loc !== 'Unknown') {
      if (!liveByLoc.has(loc)) liveByLoc.set(loc, []);
      liveByLoc.get(loc)!.push({ name: c.name, status: c.status });
    }
  }

  // Build edge weight scale for opacity
  const maxW = Math.max(...graph.edges.map((e) => e.weight), 1);

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-2 px-1">
        <p className="text-xs text-zinc-600">
          {graph.nodes.length} locations · {graph.edges.length} movement paths
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setRunning((r) => !r)}
            className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-400 transition-colors"
          >
            {running ? '⏸ Pause' : '▶ Resume'}
          </button>
          <button
            onClick={() => {
              const g = buildGraph(snapshots);
              setGraph(g);
              setRunning(true);
            }}
            className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-400 transition-colors"
          >
            ↺ Reset
          </button>
        </div>
      </div>

      <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox="0 0 800 600"
          className="w-full"
          style={{ height: 480, cursor: dragging ? 'grabbing' : 'default' }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Grid dots for ambiance */}
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <circle cx="20" cy="20" r="0.8" fill="#3f3f46" />
            </pattern>
          </defs>
          <rect width="800" height="600" fill="url(#grid)" />

          {/* Edges */}
          <g>
            {graph.edges.map((e) => {
              const s = graph.nodes.find((n) => n.id === e.source);
              const t = graph.nodes.find((n) => n.id === e.target);
              if (!s || !t) return null;
              const opacity = 0.15 + 0.5 * (e.weight / maxW);
              const strokeWidth = 1 + 2.5 * (e.weight / maxW);
              return (
                <line
                  key={`${e.source}|||${e.target}`}
                  x1={s.x} y1={s.y}
                  x2={t.x} y2={t.y}
                  stroke="#a1a1aa"
                  strokeWidth={strokeWidth}
                  strokeOpacity={opacity}
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {/* Edge weight labels (only for heavy edges) */}
          <g>
            {graph.edges.filter((e) => e.weight >= 2).map((e) => {
              const s = graph.nodes.find((n) => n.id === e.source);
              const t = graph.nodes.find((n) => n.id === e.target);
              if (!s || !t) return null;
              const mx = (s.x + t.x) / 2;
              const my = (s.y + t.y) / 2;
              return (
                <text
                  key={`lbl-${e.source}|||${e.target}`}
                  x={mx} y={my}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="9"
                  fill="#71717a"
                >
                  {e.weight}
                </text>
              );
            })}
          </g>

          {/* Nodes — circles + labels only, no avatars */}
          {(() => {
            const fills = ['#f43f5e22','#0ea5e922','#8b5cf622','#10b98122','#f59e0b22','#ec489922','#14b8a622','#6366f122'];
            const strokes = ['#f43f5e99','#0ea5e999','#8b5cf699','#10b98199','#f59e0b99','#ec489999','#14b8a699','#6366f199'];
            const labelFills = ['#fb7185','#38bdf8','#a78bfa','#34d399','#fbbf24','#f472b6','#2dd4bf','#818cf8'];

            // Also pre-compute absolute avatar positions for the flat list below
            const charPos = new Map<string, { x: number; y: number; status: CharAvatar['status'] }>();
            const AVT = 7;

            const nodes = graph.nodes.map((n) => {
              const ci = nodeColor(n.id);
              const chars = liveByLoc.get(n.id) ?? [];
              const r = Math.max(16, Math.min(28, 16 + chars.length * 2));
              const labelAngle = pickAngle(n.id, graph.nodes, graph.edges);
              const lx = Math.cos(labelAngle) * (r + 12);
              const ly = Math.sin(labelAngle) * (r + 12);
              const anchor = (Math.cos(labelAngle) > 0.3 ? 'start' : Math.cos(labelAngle) < -0.3 ? 'end' : 'middle') as 'start' | 'end' | 'middle';
              const baseline = (Math.sin(labelAngle) > 0.3 ? 'hanging' : Math.sin(labelAngle) < -0.3 ? 'auto' : 'central') as 'hanging' | 'auto' | 'central';

              const ringR = r + AVT + 4;
              const step = chars.length > 0 ? (2 * Math.PI) / chars.length : 0;
              const startAngle = labelAngle + Math.PI;
              chars.forEach((c, i) => {
                const a = startAngle + i * step;
                charPos.set(c.name, { x: n.x + Math.cos(a) * ringR, y: n.y + Math.sin(a) * ringR, status: c.status });
              });

              return { n, ci, r, lx, ly, anchor, baseline };
            });

            return (
              <>
                {nodes.map(({ n, ci, r, lx, ly, anchor, baseline }) => (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    onMouseDown={(e) => handleMouseDown(e, n.id)}
                    style={{ cursor: 'grab' }}
                  >
                    <circle r={r} fill={fills[ci]} stroke={strokes[ci]} strokeWidth="1.5" />
                    <text x={lx} y={ly} textAnchor={anchor} dominantBaseline={baseline}
                      fontSize="10" fontWeight="500" fill={labelFills[ci]}>
                      {n.id.length > 20 ? n.id.slice(0, 18) + '…' : n.id}
                    </text>
                  </g>
                ))}

                {/* Character avatars — flat list keyed by name so CSS transition fires on move */}
                {Array.from(charPos.entries()).map(([name, { x, y, status }]) => {
                  const hex = STATUS_HEX[status];
                  return (
                    <g
                      key={name}
                      style={{
                        transform: `translate(${x}px, ${y}px)`,
                        transition: running ? 'none' : 'transform 0.65s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      <title>{name} ({status})</title>
                      <circle r={AVT} fill={hex + '28'} stroke={hex} strokeWidth="1.5" />
                      <text textAnchor="middle" dominantBaseline="central" fontSize="5" fontWeight="700" fill={hex}>
                        {charInitials(name)}
                      </text>
                    </g>
                  );
                })}
              </>
            );
          })()}
        </svg>
      </div>

      <p className="text-xs text-zinc-700 mt-2 text-center">
        Node size = characters present · Line thickness = movement frequency · Drag nodes to rearrange
      </p>
    </div>
  );
}
