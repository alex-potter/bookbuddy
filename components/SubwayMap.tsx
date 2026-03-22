'use client';

import { useEffect, useRef, useState } from 'react';
import type { Character, LocationInfo, Snapshot } from '@/types';
import { withResolvedLocations, buildLocationAliasMap, resolveLocationName } from '@/lib/resolve-locations';

/* ── Types ────────────────────────────────────────────────────────────── */

interface Node {
  id: string;
  arc?: string;     // narrative arc this location belongs to
  anchorX: number;  // target X derived from first-appearance chapter
  anchorY: number;  // target Y = centre of arc lane
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface ArcLane {
  name: string;     // raw arc string (empty string = unlabelled catch-all)
  label: string;    // display label
  y: number;        // centre Y of the band
  height: number;   // pixel height of the band
}

interface Edge {
  source: string;
  target: string;
  weight: number;
  color: string;        // primary color (used for station rings)
  sourceColor: string;  // gradient start — color of source→target travel
  targetColor: string;  // gradient end   — color of target→source travel
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

const LANE_MARGIN_LEFT  = 108;
const LANE_MARGIN_RIGHT =  24;
const LANE_MARGIN_TOP   =  30;
const LANE_MARGIN_BOT   =  30;

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

/* ── Character path animation helpers ────────────────────────────────── */

// nx/ny = destination node centre (used for train path; optional for positions
// that haven't been through a full animation yet)
type CharPos = { x: number; y: number; status: Character['status']; nx?: number; ny?: number };
const CHAR_ANIM_MS = 700;  // ms for train phase (source → dest node centre)
const CLUSTER_PHASE_MS = 220; // ms for cluster phase (dest node centre → cluster slot)

/** Subway-style L-path waypoints between two pixel points. */
function pathWaypoints(x1: number, y1: number, x2: number, y2: number): [number, number][] {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return [[x1, y1], [x1 + Math.sign(dx) * Math.abs(dy), y2], [x2, y2]];
  }
  return [[x1, y1], [x2, y1 + Math.sign(dy) * Math.abs(dx)], [x2, y2]];
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function posAlong(pts: [number, number][], t: number): [number, number] {
  const segs = pts.length - 1;
  const st = t * segs;
  const s = Math.min(Math.floor(st), segs - 1);
  const f = st - s;
  return [pts[s][0] + (pts[s + 1][0] - pts[s][0]) * f, pts[s][1] + (pts[s + 1][1] - pts[s][1]) * f];
}

function findNearestNode(x: number, y: number, nodes: Node[]): Node {
  let best = nodes[0];
  let bestD = Infinity;
  for (const n of nodes) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/* ── Graph extraction (structure only — no character data) ────────────── */

// Returns true only for real, concrete place names.
// Filters out placeholder values the LLM emits when a location is uncertain.
const FAKE_LOC_RE = /^(unknown|not specified|unspecified|unclear|n\/a|none|various|en route|in transit|travelling|traveling|returning|heading|journeying|fleeing|marching|riding|sailing|making (his|her|their|its|the) way|dead|killed|deceased|slain|captured|imprisoned|on the road|on the move|on (his|her|their|its) way|on the run|whereabouts)/i;
function isRealLocation(loc: string | undefined): loc is string {
  if (!loc) return false;
  const t = loc.trim();
  return t.length > 0 && !FAKE_LOC_RE.test(t);
}

function buildGraph(snapshots: Snapshot[], locationMergeMap?: Map<string, string>, currentLocations?: LocationInfo[], prebuiltAliasMap?: Map<string, string>): { nodes: Node[]; edges: Edge[]; arcLanes: ArcLane[]; maxChapter: number } {
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return { nodes: [], edges: [], arcLanes: [], maxChapter: 0 };

  const maxChapter = sorted[sorted.length - 1].index;

  // Use pre-built alias map if provided, otherwise build from snapshots
  const aliasMap = prebuiltAliasMap ?? buildLocationAliasMap(snapshots, currentLocations ?? sorted[sorted.length - 1]?.result.locations);
  const resolveLoc = (name: string | undefined) => {
    const resolved = resolveLocationName(name, aliasMap);
    if (!resolved || !locationMergeMap) return resolved;
    return locationMergeMap.get(resolved) ?? resolved;
  };

  // Collect all real location names, arc labels, and first-appearance chapter per location
  const allLocs = new Set<string>();
  const locArc = new Map<string, string>();
  const locFirstChapter = new Map<string, number>();
  for (const snap of sorted) {
    for (const c of snap.result.characters) {
      const loc = resolveLoc(c.currentLocation?.trim());
      if (isRealLocation(loc)) {
        allLocs.add(loc);
        if (!locFirstChapter.has(loc)) locFirstChapter.set(loc, snap.index);
      }
    }
    for (const l of snap.result.locations ?? []) {
      const name = resolveLoc(l.name?.trim());
      if (isRealLocation(name) && l.arc?.trim()) locArc.set(name, l.arc.trim());
    }
  }

  // Track DIRECTED edge counts so A→B and B→A are distinct
  const dirCounts = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prevMap = new Map<string, string>();
    for (const c of sorted[i - 1].result.characters) {
      const loc = resolveLoc(c.currentLocation?.trim());
      if (isRealLocation(loc)) prevMap.set(c.name, loc);
    }
    for (const c of sorted[i].result.characters) {
      const newLoc = resolveLoc(c.currentLocation?.trim());
      const oldLoc = prevMap.get(c.name);
      if (!isRealLocation(newLoc) || !isRealLocation(oldLoc) || newLoc === oldLoc) continue;
      const key = `${oldLoc}\x00${newLoc}`;
      dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
    }
  }

  // Assign colors to directed edges by frequency rank
  const sortedDir = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
  const dirColor = new Map<string, string>();
  sortedDir.forEach(([key], i) => dirColor.set(key, LINE_COLORS[i % LINE_COLORS.length]));

  // Collapse directed edges into undirected pairs (for physics + rendering)
  const undirMap = new Map<string, { source: string; target: string; weight: number; sourceColor: string; targetColor: string }>();
  for (const [key, count] of dirCounts) {
    const [a, b] = key.split('\x00');
    const pairKey = [a, b].sort().join('\x00');
    if (!undirMap.has(pairKey)) {
      const ab = dirColor.get(`${a}\x00${b}`);
      const ba = dirColor.get(`${b}\x00${a}`);
      undirMap.set(pairKey, {
        source: a, target: b, weight: count,
        sourceColor: ab ?? ba ?? LINE_COLORS[0],
        targetColor: ba ?? ab ?? LINE_COLORS[0],
      });
    } else {
      undirMap.get(pairKey)!.weight += count;
    }
  }

  const edges: Edge[] = [...undirMap.values()].map((e) => ({ ...e, color: e.sourceColor }));

  // Nodes = locations with edges + any location seen in any snapshot
  const nodeIds = new Set<string>();
  for (const e of edges) { nodeIds.add(e.source); nodeIds.add(e.target); }
  for (const loc of allLocs) nodeIds.add(loc);

  // Build arc lanes sorted by earliest first-appearance among each arc's locations
  const arcFirstChapter = new Map<string, number>();
  for (const [loc, arc] of locArc) {
    const ch = locFirstChapter.get(loc) ?? 0;
    const prev = arcFirstChapter.get(arc);
    if (prev === undefined || ch < prev) arcFirstChapter.set(arc, ch);
  }
  const namedArcs = [...arcFirstChapter.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([arc]) => arc);
  const hasUnlabelled = [...nodeIds].some((id) => !locArc.has(id));
  // Unlabelled locations go in a catch-all lane (empty string key) at the bottom
  const allArcNames = hasUnlabelled ? [...namedArcs, ''] : namedArcs;
  const totalLanes = Math.max(allArcNames.length, 1);
  const laneH = (H - LANE_MARGIN_TOP - LANE_MARGIN_BOT) / totalLanes;

  const arcLanes: ArcLane[] = allArcNames.map((name, i) => ({
    name,
    label: name || 'Other',
    y: LANE_MARGIN_TOP + laneH * i + laneH / 2,
    height: laneH,
  }));
  const laneByArc = new Map(arcLanes.map((l) => [l.name, l]));

  // X mapping: first-appearance chapter → X position
  const usableW = W - LANE_MARGIN_LEFT - LANE_MARGIN_RIGHT;

  const nodes: Node[] = Array.from(nodeIds).map((id) => {
    const arc = locArc.get(id) ?? '';
    const lane = laneByArc.get(arc) ?? arcLanes[arcLanes.length - 1];
    const ch = locFirstChapter.get(id) ?? 0;
    const anchorX = LANE_MARGIN_LEFT + (maxChapter > 0 ? (ch / maxChapter) * usableW : usableW / 2);
    const anchorY = lane.y;
    return {
      id,
      arc: locArc.get(id),
      anchorX,
      anchorY,
      x: anchorX + (Math.random() - 0.5) * 60,
      y: anchorY + (Math.random() - 0.5) * (laneH * 0.5),
      vx: 0,
      vy: 0,
    };
  });

  return { nodes, edges, arcLanes, maxChapter };
}

/* ── Physics ──────────────────────────────────────────────────────────── */

const REPULSION = 10000;
const SPRING_K = 0.04;
const SPRING_REST = 180;
const DAMPING = 0.80;
const ANCHOR_GRAVITY_Y = 0.08;   // strong: keeps nodes within their arc lane
const ANCHOR_GRAVITY_X = 0.010;  // weak: gentle pull toward first-appearance X

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

  // Anchor gravity — strong Y pull keeps node in its arc lane; weak X pull toward first-appearance position
  for (const n of next) {
    n.vx += (n.anchorX - n.x) * ANCHOR_GRAVITY_X;
    n.vy += (n.anchorY - n.y) * ANCHOR_GRAVITY_Y;
  }

  for (const n of next) {
    n.vx *= DAMPING; n.vy *= DAMPING;
    n.x = Math.max(LANE_MARGIN_LEFT - 20, Math.min(W - LANE_MARGIN_RIGHT + 20, n.x + n.vx));
    n.y = Math.max(LANE_MARGIN_TOP,       Math.min(H - LANE_MARGIN_BOT,        n.y + n.vy));
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

/**
 * Same L-path but every point shifted by (ox, oy).
 * Used to draw parallel transit lines side-by-side when two arc-coloured
 * lines share the same track segment.
 */
function offsetSubwayPath(x1: number, y1: number, x2: number, y2: number, ox: number, oy: number): string {
  const dx = x2 - x1; const dy = y2 - y1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const cx = x1 + Math.sign(dx) * Math.abs(dy);
    return `M ${x1+ox} ${y1+oy} L ${cx+ox} ${y2+oy} L ${x2+ox} ${y2+oy}`;
  } else {
    const cy = y1 + Math.sign(dy) * Math.abs(dx);
    return `M ${x1+ox} ${y1+oy} L ${x2+ox} ${cy+oy} L ${x2+ox} ${y2+oy}`;
  }
}

/** Perpendicular unit vector scaled to distance d, relative to the line from (x1,y1)→(x2,y2). */
function perpOffset(x1: number, y1: number, x2: number, y2: number, d: number): [number, number] {
  const dx = x2 - x1; const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [-dy / len * d, dx / len * d];
}

/* ── Component ────────────────────────────────────────────────────────── */

interface Props {
  snapshots: Snapshot[];
  currentCharacters?: Character[];  // characters at the currently viewed snapshot
  currentLocations?: LocationInfo[];  // full current result locations for alias resolution
  locationMergeMap?: Map<string, string>;  // child location → root parent name
  locationAliasMap?: Map<string, string>;  // pre-built canonical alias map
  onCharacterClick?: (name: string) => void;
  onLocationClick?: (name: string) => void;
  onArcClick?: (arcName: string) => void;
}

export default function SubwayMap({ snapshots, currentCharacters = [], currentLocations, locationMergeMap, locationAliasMap: aliasMapProp, onCharacterClick, onLocationClick, onArcClick }: Props) {
  const [charSearch, setCharSearch] = useState('');
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    obs.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[]; arcLanes: ArcLane[]; maxChapter: number }>(() => buildGraph(snapshots, locationMergeMap, currentLocations, aliasMapProp));
  const [settled, setSettled] = useState(false);
  const frameRef = useRef<number>(0);

  // Character path-following animation
  const [displayPos, setDisplayPos] = useState<Map<string, CharPos>>(new Map());
  const displayPosRef = useRef<Map<string, CharPos>>(new Map());
  const targetPosRef = useRef<Map<string, CharPos>>(new Map());
  const pendingAnims = useRef<Map<string, {
    waypoints: [number, number][];  // source cluster → dest node centre
    t0: number;                     // start time (staggered for train effect)
    status: Character['status'];
    nodeX: number; nodeY: number;   // dest node centre (end of train phase)
    clusterX: number; clusterY: number; // final cluster slot (end of cluster phase)
  }>>(new Map());
  const charRafRef = useRef<number>(0);
  type ActiveRoute = { x1: number; y1: number; x2: number; y2: number };
  const [activeRoutes, setActiveRoutes] = useState<ActiveRoute[]>([]);

  // Rebuild graph structure when snapshots, merge map, or current locations change
  useEffect(() => {
    setGraph(buildGraph(snapshots, locationMergeMap, currentLocations, aliasMapProp));
    setSettled(false);
  }, [snapshots, locationMergeMap, currentLocations, aliasMapProp]);

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
        return { nodes: next, edges: prev.edges, arcLanes: prev.arcLanes, maxChapter: prev.maxChapter };
      });
      if (count < MAX) frameRef.current = requestAnimationFrame(loop);
    }
    frameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRef.current);
  }, [settled]);

  // Animate character avatars along subway paths when their location changes.
  // Characters moving from the same source area to the same destination travel
  // in a staggered single-file "train"; on arrival they fan out to cluster slots.
  useEffect(() => {
    if (!settled) return;
    const targets = targetPosRef.current;
    const current = displayPosRef.current;
    const now = performance.now();

    // Group moving characters into trains: same source area + same dest node centre
    type MovingChar = { name: string; cur: CharPos; target: CharPos };
    const trains = new Map<string, MovingChar[]>();

    for (const [name, target] of targets) {
      const cur = current.get(name);
      if (!cur) { current.set(name, target); continue; }
      const dx = target.x - cur.x, dy = target.y - cur.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        if (cur.status !== target.status) current.set(name, { ...cur, status: target.status });
        continue;
      }
      // Group key: source 40px bucket + exact dest node centre
      const srcKey = `${Math.round(cur.x / 40)},${Math.round(cur.y / 40)}`;
      const dstKey = `${target.nx ?? Math.round(target.x)},${target.ny ?? Math.round(target.y)}`;
      const key = `${srcKey}->${dstKey}`;
      if (!trains.has(key)) trains.set(key, []);
      trains.get(key)!.push({ name, cur, target });
    }
    // Remove departed characters
    for (const name of [...current.keys()]) {
      if (!targets.has(name)) current.delete(name);
    }
    setDisplayPos(new Map(current));

    cancelAnimationFrame(charRafRef.current);
    if (trains.size === 0) return;

    // Compute highlighted route segments (source node centre → dest node centre)
    const routes: ActiveRoute[] = [];
    for (const group of trains.values()) {
      if (group.length === 0) continue;
      const rep = group[0];
      const srcNode = findNearestNode(rep.cur.x, rep.cur.y, graph.nodes);
      const destNodeX = rep.target.nx ?? rep.target.x;
      const destNodeY = rep.target.ny ?? rep.target.y;
      routes.push({ x1: srcNode.x, y1: srcNode.y, x2: destNodeX, y2: destNodeY });
    }
    setActiveRoutes(routes);

    const STAGGER_MS = 75; // gap between each character in the train
    for (const group of trains.values()) {
      group.sort((a, b) => a.name.localeCompare(b.name)); // stable train order
      group.forEach(({ name, cur, target }, i) => {
        const nodeX = target.nx ?? target.x;
        const nodeY = target.ny ?? target.y;
        pendingAnims.current.set(name, {
          // Path goes from source cluster slot → dest node centre (shared subway line)
          waypoints: pathWaypoints(cur.x, cur.y, nodeX, nodeY),
          t0: now + i * STAGGER_MS,
          status: target.status,
          nodeX, nodeY,
          clusterX: target.x,
          clusterY: target.y,
        });
      });
    }

    function animate(ts: number) {
      const pos = new Map(displayPosRef.current);
      let anyActive = false;
      for (const [name, anim] of pendingAnims.current) {
        const elapsed = ts - anim.t0;
        let x: number, y: number;
        if (elapsed <= 0) {
          // Waiting in train queue — stay at source position
          [x, y] = anim.waypoints[0];
        } else if (elapsed < CHAR_ANIM_MS) {
          // Train phase: travel along subway path to dest node centre
          [x, y] = posAlong(anim.waypoints, easeInOut(elapsed / CHAR_ANIM_MS));
        } else if (elapsed < CHAR_ANIM_MS + CLUSTER_PHASE_MS) {
          // Cluster phase: fan out from node centre to individual slot
          const ct = easeInOut((elapsed - CHAR_ANIM_MS) / CLUSTER_PHASE_MS);
          x = anim.nodeX + (anim.clusterX - anim.nodeX) * ct;
          y = anim.nodeY + (anim.clusterY - anim.nodeY) * ct;
        } else {
          x = anim.clusterX; y = anim.clusterY;
        }
        pos.set(name, { x, y, status: anim.status });
        if (elapsed >= CHAR_ANIM_MS + CLUSTER_PHASE_MS) pendingAnims.current.delete(name);
        else anyActive = true;
      }
      displayPosRef.current = pos;
      setDisplayPos(new Map(pos));
      if (!anyActive) setActiveRoutes([]);
      if (anyActive) charRafRef.current = requestAnimationFrame(animate);
    }
    charRafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(charRafRef.current);
  }, [currentCharacters, settled]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 gap-2">
        <span className="text-3xl opacity-20">🗺️</span>
        <p className="text-xs text-stone-400 dark:text-zinc-600">Analyze chapters to populate the map</p>
      </div>
    );
  }

  // Build live character→location map from currentCharacters (updates with snapshot nav).
  // Characters with unknown locations fall back to their last confirmed location.
  const allResolved = withResolvedLocations(currentCharacters, snapshots);
  const resolvedCharacters = charSearch.trim()
    ? (() => {
        const q = charSearch.toLowerCase();
        return allResolved.filter((c) =>
          c.name.toLowerCase().includes(q) ||
          (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
        );
      })()
    : allResolved;
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

  const { arcLanes, maxChapter } = graph;

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
  const charPositions = new Map<string, CharPos>();
  const overflowBadges: Array<{ x: number; y: number; count: number }> = [];

  const nodeData = graph.nodes.map((n) => {
    const colors = graph.edges
      .filter((e) => e.source === n.id || e.target === n.id)
      .map((e) => (e.source === n.id ? e.sourceColor : e.targetColor));
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
      if (positions[i]) charPositions.set(c.name, { x: positions[i].x, y: positions[i].y, status: c.status, nx: n.x, ny: n.y });
    });
    if (extra > 0 && positions[MAX_SHOW]) {
      overflowBadges.push({ x: positions[MAX_SHOW].x, y: positions[MAX_SHOW].y, count: extra });
    }

    return { n, primaryColor, r, lines, labelX, labelY, labelAnchor, labelBaseline };
  });

  // Penalty box — characters with no real map location (in transit, status phrases, etc.)
  const PB_W = 170, PB_H = 75;
  const PB_X = W - PB_W - 10, PB_Y = H - PB_H - 10;
  const pbCX = PB_X + PB_W / 2;
  const pbCY = PB_Y + 18 + (PB_H - 22) / 2; // vertically centred below the label

  const penaltyChars = resolvedCharacters
    .filter((c) => !charPositions.has(c.name))
    .map((c) => ({ name: c.name, status: c.status }));
  const pbShow = penaltyChars.slice(0, MAX_SHOW);
  const pbExtra = penaltyChars.length - MAX_SHOW;
  const pbShowCount = pbShow.length + (pbExtra > 0 ? 1 : 0);
  if (penaltyChars.length > 0) {
    const pbPositions = clusterPositions(pbShowCount, pbCX, pbCY);
    pbShow.forEach((c, i) => {
      if (pbPositions[i]) charPositions.set(c.name, { x: pbPositions[i].x, y: pbPositions[i].y, status: c.status, nx: pbCX, ny: pbCY });
    });
  }

  // Expose computed target positions to the animation effect
  targetPosRef.current = charPositions;

  // Grid as a CSS background so it covers the full container, not just the SVG viewBox
  const gridColor = isDark ? '%2327272a' : '%23e7e5e4';
  const gridBg = `url("data:image/svg+xml,%3Csvg width='30' height='30' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M 30 0 L 0 0 0 30' fill='none' stroke='${gridColor}' stroke-width='0.5'/%3E%3C/svg%3E")`;

  // Theme-dependent SVG colors
  const nodeFill = isDark ? '#18181b' : '#ffffff';
  const labelFill = isDark ? '#e4e4e7' : '#1c1917';
  const labelShadow = isDark ? '0 1px 4px #000, 0 0 8px #000' : '0 1px 3px rgba(255,255,255,0.8)';
  const overflowFill = isDark ? '#27272a' : '#f5f5f4';
  const overflowStroke = isDark ? '#52525b' : '#d6d3d1';
  const overflowText = isDark ? '#a1a1aa' : '#78716c';
  const zoneCircleFill = isDark ? 'white' : 'black';

  return (
    <div className={`relative w-full h-full ${isDark ? 'bg-zinc-950' : 'bg-stone-50'}`} style={{ backgroundImage: gridBg }}>
      {/* Character search overlay */}
      <div className="absolute top-2 right-2 z-20">
        <input
          type="search"
          placeholder="Find character…"
          value={charSearch}
          onChange={(e) => setCharSearch(e.target.value)}
          className={`w-36 text-[11px] px-2.5 py-1.5 rounded-lg border outline-none transition-colors ${
            isDark
              ? 'bg-zinc-900/90 border-zinc-700 text-zinc-300 placeholder-zinc-600 focus:border-zinc-500'
              : 'bg-white/90 border-stone-300 text-stone-700 placeholder-stone-400 focus:border-stone-400'
          }`}
        />
      </div>
      {/* Spinner shown while physics settles */}
      {!settled && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2">
          <div className={`w-5 h-5 rounded-full border-2 animate-spin ${isDark ? 'border-zinc-700 border-t-zinc-400' : 'border-stone-300 border-t-stone-500'}`} />
          <p className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-stone-400'}`}>Laying out map…</p>
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

      {/* Arc swimlane bands — rendered first so everything else sits on top */}
      {arcLanes.map((lane, i) => (
        <g key={`lane-${lane.name || '_other'}`}>
          {/* Alternating band shading */}
          {i % 2 === 0 && (
            <rect
              x={LANE_MARGIN_LEFT - 4} y={lane.y - lane.height / 2}
              width={W - LANE_MARGIN_LEFT - LANE_MARGIN_RIGHT + 4} height={lane.height}
              fill={zoneCircleFill} opacity={0.018}
            />
          )}
          {/* Divider line between lanes */}
          {i > 0 && (
            <line
              x1={LANE_MARGIN_LEFT - 4} y1={lane.y - lane.height / 2}
              x2={W - LANE_MARGIN_RIGHT} y2={lane.y - lane.height / 2}
              stroke={zoneCircleFill} strokeWidth={0.5} opacity={0.1}
            />
          )}
          {/* Arc label — left margin, vertically centred in band */}
          {(() => {
            const arcColor = lane.name ? LINE_COLORS[i % LINE_COLORS.length] : (isDark ? '#52525b' : '#a8a29e');
            const clickable = !!lane.name && !!onArcClick;
            const handleArcClick = clickable ? () => onArcClick!(lane.name) : undefined;
            return (
              <g style={{ cursor: clickable ? 'pointer' : 'default' }} onClick={handleArcClick}>
                <rect
                  x={0} y={lane.y - lane.height / 2}
                  width={LANE_MARGIN_LEFT - 5} height={lane.height}
                  fill="transparent"
                />
                <line
                  x1={LANE_MARGIN_LEFT - 4} y1={lane.y - lane.height / 2}
                  x2={LANE_MARGIN_LEFT - 4} y2={lane.y + lane.height / 2}
                  stroke={arcColor} strokeWidth={2} opacity={0.5}
                />
                <text
                  x={LANE_MARGIN_LEFT - 10} y={lane.y}
                  textAnchor="end" dominantBaseline="central"
                  fontSize={9.5} fontWeight="700" letterSpacing="0.06em"
                  fill={arcColor} opacity={0.85}
                  style={{ userSelect: 'none' }}
                >
                  {lane.label.toUpperCase()}
                </text>
              </g>
            );
          })()}
        </g>
      ))}

      {/* Time axis — subtle chapter markers along the top */}
      {maxChapter > 0 && (() => {
        const usableW = W - LANE_MARGIN_LEFT - LANE_MARGIN_RIGHT;
        const tickCount = Math.min(maxChapter + 1, 8);
        const ticks = Array.from({ length: tickCount }, (_, i) =>
          Math.round((i / Math.max(tickCount - 1, 1)) * maxChapter),
        );
        return (
          <g>
            {ticks.map((ch) => {
              const tx = LANE_MARGIN_LEFT + (ch / maxChapter) * usableW;
              return (
                <g key={ch}>
                  <line x1={tx} y1={LANE_MARGIN_TOP - 6} x2={tx} y2={LANE_MARGIN_TOP - 2}
                    stroke={zoneCircleFill} strokeWidth={0.8} opacity={0.18} />
                  <text x={tx} y={LANE_MARGIN_TOP - 8}
                    textAnchor="middle" dominantBaseline="auto"
                    fontSize={7} fill={zoneCircleFill} opacity={0.22}
                    style={{ userSelect: 'none' }}>
                    Ch.{ch + 1}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })()}

      {/* Transit lines
          Each edge gets a perpendicular slot offset computed from its angular rank
          among all edges at each endpoint — this separates lines that would otherwise
          overlap when two edges arrive at the same node from similar directions.
          Bidirectional edges occupy two adjacent sub-slots (one per direction). */}
      {(() => {
        const LINE_SEP = 3.2; // px between the centres of adjacent parallel lines

        // Expand each undirected edge into directed "line ends":
        // bidir edge → 2 line-ends per node; single → 1 line-end per node.
        // lineEndKey = `${fromNode}\x00${toNode}::${color}` (unique per directed line)
        type LineEnd = { fromId: string; toId: string; color: string };
        const allLineEnds: LineEnd[] = [];
        for (const e of graph.edges) {
          allLineEnds.push({ fromId: e.source, toId: e.target, color: e.sourceColor });
          if (e.sourceColor !== e.targetColor) {
            allLineEnds.push({ fromId: e.target, toId: e.source, color: e.targetColor });
          }
        }

        // For each node, sort its incident line-ends by angle and assign lateral slots
        // slot: `${fromId}\x00${toId}::${color}` → perpendicular offset at `fromId`
        const slotAt = new Map<string, number>();
        for (const node of graph.nodes) {
          const inc = allLineEnds
            .filter(le => le.fromId === node.id)
            .map(le => {
              const other = nodeMap.get(le.toId);
              return { le, angle: other ? Math.atan2(other.y - node.y, other.x - node.x) : 0 };
            })
            .sort((a, b) => a.angle - b.angle);
          if (inc.length <= 1) continue;
          inc.forEach(({ le }, i) => {
            const slot = (i - (inc.length - 1) / 2) * LINE_SEP;
            slotAt.set(`${le.fromId}\x00${le.toId}::${le.color}`, slot);
          });
        }

        // Average the slot at each end of the line to get a single uniform offset
        function lineOffset(fromId: string, toId: string, color: string): number {
          const fwd = slotAt.get(`${fromId}\x00${toId}::${color}`) ?? 0;
          const rev = slotAt.get(`${toId}\x00${fromId}::${color}`) ?? 0;
          return (fwd - rev) / 2; // rev is from the other end — flip sign
        }

        const lineW = (weight: number) => 1.5 + 1.5 * (weight / maxW);

        return (
          <g>
            {graph.edges.map((e) => {
              const s = nodeMap.get(e.source);
              const t = nodeMap.get(e.target);
              if (!s || !t) return null;
              const bidir = e.sourceColor !== e.targetColor;
              const lw = lineW(e.weight);
              const key = `${e.source}\x00${e.target}`;

              if (bidir) {
                const off1 = lineOffset(e.source, e.target, e.sourceColor);
                const off2 = lineOffset(e.target, e.source, e.targetColor);
                const [ox1, oy1] = perpOffset(s.x, s.y, t.x, t.y, off1);
                const [ox2, oy2] = perpOffset(s.x, s.y, t.x, t.y, off2);
                return (
                  <g key={key}>
                    <path d={offsetSubwayPath(s.x, s.y, t.x, t.y, ox1, oy1)} fill="none" stroke={e.sourceColor} strokeWidth={lw} strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
                    <path d={offsetSubwayPath(s.x, s.y, t.x, t.y, ox2, oy2)} fill="none" stroke={e.targetColor} strokeWidth={lw} strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
                  </g>
                );
              }

              const off = lineOffset(e.source, e.target, e.sourceColor);
              const [ox, oy] = perpOffset(s.x, s.y, t.x, t.y, off);
              return (
                <path key={key} d={offsetSubwayPath(s.x, s.y, t.x, t.y, ox, oy)}
                  fill="none" stroke={e.sourceColor} strokeWidth={lw * 2}
                  strokeLinecap="round" strokeLinejoin="round" opacity={0.65} />
              );
            })}
          </g>
        );
      })()}

      {/* Active train route highlights — bright overlay on paths while characters travel */}
      {activeRoutes.map(({ x1, y1, x2, y2 }, i) => (
        <path
          key={i}
          d={subwayPath(x1, y1, x2, y2)}
          fill="none"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#sm-glow)"
        />
      ))}

      {/* Station circles — rendered before labels so labels always appear on top */}
      {nodeData.map(({ n, primaryColor, r }) => (
        <g
          key={n.id}
          filter="url(#sm-glow)"
          style={{ cursor: onLocationClick ? 'pointer' : 'default' }}
          onClick={() => onLocationClick?.(n.id)}
        >
          <circle cx={n.x} cy={n.y} r={r + 6} fill="transparent" />
          <circle cx={n.x} cy={n.y} r={r + 3} fill={primaryColor} opacity={0.2} />
          <circle cx={n.x} cy={n.y} r={r} fill={nodeFill} stroke={primaryColor} strokeWidth={2.5} />
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
            fontSize={LABEL_FONT} fontWeight="600" fill={labelFill}
            style={{ textShadow: labelShadow, cursor: onLocationClick ? 'pointer' : 'default' }}
            onClick={() => onLocationClick?.(n.id)}
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
          <circle r={AVT_R} fill={overflowFill} stroke={overflowStroke} strokeWidth="1" />
          <text textAnchor="middle" dominantBaseline="central" fontSize="5" fill={overflowText}>+{count}</text>
        </g>
      ))}

      {/* Penalty box — characters in transit or at status-only locations */}
      {penaltyChars.length > 0 && (() => {
        const pbPositions = clusterPositions(pbShowCount, pbCX, pbCY);
        return (
          <g>
            <rect x={PB_X} y={PB_Y} width={PB_W} height={PB_H} rx={6}
              fill={isDark ? 'rgba(24,24,27,0.92)' : 'rgba(250,250,249,0.92)'}
              stroke={isDark ? 'rgba(82,82,91,0.65)' : 'rgba(168,162,158,0.65)'}
              strokeWidth={1} strokeDasharray="4 3"
            />
            <text x={PB_X + PB_W / 2} y={PB_Y + 10}
              textAnchor="middle" dominantBaseline="central"
              fontSize={7} fontWeight="700" letterSpacing="0.07em"
              fill={isDark ? '#71717a' : '#a8a29e'}
              style={{ textTransform: 'uppercase', userSelect: 'none' }}>
              In Transit
            </text>
            {pbExtra > 0 && pbPositions[MAX_SHOW] && (
              <g transform={`translate(${pbPositions[MAX_SHOW].x},${pbPositions[MAX_SHOW].y})`}>
                <circle r={AVT_R} fill={overflowFill} stroke={overflowStroke} strokeWidth="1" />
                <text textAnchor="middle" dominantBaseline="central" fontSize="5" fill={overflowText}>+{pbExtra}</text>
              </g>
            )}
          </g>
        );
      })()}

      {/* Character avatars — positions driven by JS path animation, not CSS transition */}
      {Array.from(displayPos.entries()).map(([name, { x, y, status }]) => {
        const hex = STATUS_HEX[status] ?? STATUS_HEX.unknown;
        return (
          <g
            key={name}
            style={{ transform: `translate(${x}px, ${y}px)`, cursor: onCharacterClick ? 'pointer' : 'default' }}
            onClick={() => onCharacterClick?.(name)}
          >
            <title>{name} ({status})</title>
            <circle r={AVT_R} fill={hex + '28'} stroke={hex} strokeWidth="1.5" />
            <text textAnchor="middle" dominantBaseline="central" fontSize="5.5" fontWeight="700" fill={hex} style={{ pointerEvents: 'none' }}>
              {initials(name)}
            </text>
          </g>
        );
      })}

    </svg>
    </div>
  );
}
