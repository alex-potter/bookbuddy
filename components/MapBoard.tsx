'use client';

import { useEffect, useRef, useState } from 'react';
import type { Character, LocationPin, MapState, NarrativeArc, Snapshot } from '@/types';
import SubwayMap from './SubwayMap';
import CharacterModal from './CharacterModal';
import LocationModal from './LocationModal';
import NarrativeArcModal from './NarrativeArcModal';
import { withResolvedLocations } from '@/lib/resolve-locations';

interface Props {
  characters: Character[];
  arcs?: NarrativeArc[];
  bookTitle?: string;
  mapState: MapState | null;
  onMapStateChange: (state: MapState) => void;
  snapshots?: Snapshot[];
}

const ARC_STATUS_DOT: Record<NarrativeArc['status'], string> = {
  active:   'bg-amber-500',
  dormant:  'bg-stone-400 dark:bg-zinc-600',
  resolved: 'bg-emerald-500',
};

/** Resize a dataURL to fit within maxDim×maxDim, preserving aspect ratio. */
function resizeDataUrl(dataUrl: string, maxDim = 1024): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h });
    };
    img.src = dataUrl;
  });
}

function pinColor(name: string): string {
  const palette = ['#f43f5e', '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1'];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return palette[Math.abs(hash) % palette.length];
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** Normalise a location name for deduplication comparison. */
function normalizeLocation(loc: string): string {
  return loc.toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .split(',')[0]
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
}

function buildLocationMap(characters: Character[]): Map<string, Character[]> {
  // Collect characters per raw location string
  const raw = new Map<string, Character[]>();
  for (const ch of characters) {
    const loc = ch.currentLocation?.trim();
    if (!loc || loc === 'Unknown') continue;
    if (!raw.has(loc)) raw.set(loc, []);
    raw.get(loc)!.push(ch);
  }

  // Group by normalised key; use the shortest variant as the canonical display name
  const groups = new Map<string, { canonical: string; chars: Character[] }>();
  for (const [loc, chars] of raw.entries()) {
    const key = normalizeLocation(loc);
    const existing = groups.get(key);
    if (existing) {
      existing.chars.push(...chars);
      if (loc.length < existing.canonical.length) existing.canonical = loc;
    } else {
      groups.set(key, { canonical: loc, chars: [...chars] });
    }
  }

  // Merge prefix-word subsets: "Eros" (key:"eros") merges into "Eros Station" (key:"eros station")
  // Keep the more specific (longer) canonical name.
  const keys = [...groups.keys()];
  for (const shorter of keys) {
    if (!groups.has(shorter)) continue;
    for (const longer of keys) {
      if (shorter === longer || !groups.has(longer)) continue;
      if (longer.startsWith(shorter + ' ')) {
        // shorter is a prefix-word subset of longer — merge shorter into longer
        const gs = groups.get(shorter)!;
        const gl = groups.get(longer)!;
        gl.chars.push(...gs.chars);
        // canonical: prefer the longer (more specific) raw name
        if (gs.canonical.length > gl.canonical.length) gl.canonical = gs.canonical;
        groups.delete(shorter);
        break;
      }
    }
  }

  const result = new Map<string, Character[]>();
  for (const { canonical, chars } of groups.values()) result.set(canonical, chars);
  return new Map([...result.entries()].sort((a, b) => b[1].length - a[1].length));
}

const BUBBLE_PX = 28; // w-7 = 28px diameter
const BUBBLE_GAP = 2; // px between bubble edges
const BUBBLE_STEP = BUBBLE_PX + BUBBLE_GAP;

/** Return cluster positions (as % of map) for `count` bubbles centred on (cx%, cy%).
 *  Uses a tight row-grid in pixel space so bubbles never overlap regardless of aspect ratio. */
function clusterPositions(
  count: number,
  cx: number,
  cy: number,
  mapW: number,
  mapH: number,
): { x: number; y: number }[] {
  if (count === 0) return [];
  if (count === 1) return [{ x: cx, y: cy }];

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const positions: { x: number; y: number }[] = [];

  let idx = 0;
  for (let row = 0; row < rows && idx < count; row++) {
    const inRow = Math.min(cols, count - row * cols);
    for (let col = 0; col < inRow; col++) {
      const dxPx = (col - (inRow - 1) / 2) * BUBBLE_STEP;
      const dyPx = (row - (rows - 1) / 2) * BUBBLE_STEP;
      positions.push({
        x: Math.max(1, Math.min(99, cx + (dxPx / mapW) * 100)),
        y: Math.max(1, Math.min(99, cy + (dyPx / mapH) * 100)),
      });
      idx++;
    }
  }
  return positions;
}

function charImportanceColor(importance: Character['importance']): string {
  return importance === 'main' ? '#f59e0b' : importance === 'secondary' ? '#3b82f6' : '#71717a';
}

export default function MapBoard({ characters, arcs = [], bookTitle, mapState, onMapStateChange, snapshots = [] }: Props) {
  const [placingLocation, setPlacingLocation] = useState<string | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [activeCharPin, setActiveCharPin] = useState<string | null>(null);
  const [charMode, setCharMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [trackedCharNames, setTrackedCharNames] = useState<Set<string> | null>(null); // null = all
  const [selectedArc, setSelectedArc] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [charFilterQ, setCharFilterQ] = useState('');
  const [selectedCharName, setSelectedCharName] = useState<string | null>(null);
  const [selectedLocationName, setSelectedLocationName] = useState<string | null>(null);
  const [selectedArcName, setSelectedArcName] = useState<string | null>(null);

  // Auto-detect state
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, LocationPin> | null>(null); // null = no pending review

  const [dragState, setDragState] = useState<{ name: string; x: number; y: number } | null>(null);
  const wasDraggingRef = useRef(false);

  const mapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resolve last-known locations for characters currently marked 'Unknown'
  const resolvedChars = withResolvedLocations(characters, snapshots);

  const locationMap = buildLocationMap(resolvedChars);
  const locations = [...locationMap.entries()];
  const pinnedCount = mapState ? Object.keys(mapState.pins).length : 0;

  // Character filter helpers
  const displayedChars = trackedCharNames === null
    ? resolvedChars
    : resolvedChars.filter((c) => trackedCharNames.has(c.name));
  const displayedLocationMap = buildLocationMap(displayedChars);

  function toggleChar(name: string) {
    setTrackedCharNames((prev) => {
      const base = prev === null ? new Set(characters.map((c) => c.name)) : new Set(prev);
      if (base.has(name)) { base.delete(name); } else { base.add(name); }
      return base.size === characters.length ? null : base;
    });
    setSelectedArc(null);
  }

  function toggleArc(arc: NarrativeArc) {
    if (selectedArc === arc.name) {
      setSelectedArc(null);
      setTrackedCharNames(null);
    } else {
      setSelectedArc(arc.name);
      setTrackedCharNames(new Set(arc.characters));
    }
  }

  // Arc pills JSX — shared between both filter panels
  const sortedArcs = [...arcs].sort((a, b) => {
    const o = { active: 0, dormant: 1, resolved: 2 };
    return o[a.status] - o[b.status];
  });

  function ArcPills() {
    if (sortedArcs.length === 0) return null;
    return (
      <div className="flex-shrink-0 space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-zinc-600">By Arc</p>
        <div className="flex flex-wrap gap-1">
          {sortedArcs.map((arc) => (
            <button
              key={arc.name}
              onClick={() => toggleArc(arc)}
              className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                selectedArc === arc.name
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-400'
                  : 'border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 hover:border-stone-400 dark:hover:border-zinc-600'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ARC_STATUS_DOT[arc.status]}`} />
              {arc.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const sortedCharacters = [...characters].sort((a, b) => {
    const order = { main: 0, secondary: 1, minor: 2 };
    return order[a.importance] - order[b.importance];
  });

  // ESC cancels placement mode / closes suggestions
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setPlacingLocation(null); setSuggestions(null); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Dismiss popup on outside click
  useEffect(() => {
    if (!activePin) return;
    function onDown() { setActivePin(null); }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [activePin]);

  function handleImageFile(file: File) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      onMapStateChange({ imageDataUrl: dataUrl, pins: mapState?.pins ?? {} });
      setSuggestions(null);
      setShowUploadPanel(false);
    };
    reader.readAsDataURL(file);
  }

  async function loadFromUrl(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setUrlLoading(true);
    setUrlError(null);
    try {
      const res = await fetch('/api/fetch-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load image');
      onMapStateChange({ imageDataUrl: data.dataUrl, pins: mapState?.pins ?? {} });
      setSuggestions(null);
      setUrlInput('');
      setShowUploadPanel(false);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : 'Failed to load image');
    } finally {
      setUrlLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    // File dragged from OS
    const file = e.dataTransfer.files[0];
    if (file) { handleImageFile(file); return; }
    // Image dragged from browser (passes URL)
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (url?.match(/^https?:\/\//)) loadFromUrl(url);
  }

  function handlePinPointerDown(e: React.PointerEvent, name: string) {
    if (placingLocation) return;
    e.stopPropagation();
    e.preventDefault();
    setActivePin(null);
    setDragState({ name, x: mapState!.pins[name].x, y: mapState!.pins[name].y });
    mapRef.current?.setPointerCapture(e.pointerId);
  }

  function handleMapPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragState || !mapRef.current) return;
    const rect = mapRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setDragState({ ...dragState, x, y });
  }

  function handleMapPointerUp() {
    if (!dragState || !mapState) return;
    wasDraggingRef.current = true;
    onMapStateChange({ ...mapState, pins: { ...mapState.pins, [dragState.name]: { x: dragState.x, y: dragState.y } } });
    setDragState(null);
  }

  function handleMapClick(e: React.MouseEvent<HTMLDivElement>) {
    if (wasDraggingRef.current) { wasDraggingRef.current = false; return; }
    setActiveCharPin(null);
    if (!placingLocation || !mapRef.current || !mapState) return;
    const rect = mapRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    onMapStateChange({
      imageDataUrl: mapState.imageDataUrl,
      pins: { ...mapState.pins, [placingLocation]: { x, y } },
    });
    setPlacingLocation(null);
  }

  function removePin(location: string) {
    if (!mapState) return;
    const pins = { ...mapState.pins };
    delete pins[location];
    onMapStateChange({ imageDataUrl: mapState.imageDataUrl, pins });
  }

  function isPlaceName(name: string): boolean {
    // Exclude narrative descriptions and vague locations
    return !/^(unknown|travelling|traveling|on the|on a|on his|on her|near |inside |a camp|the site|road near|referenced|unnamed|in the|heading|moving|sailing|riding|returning|fleeing|escaping|somewhere|various)/i.test(name.trim());
  }

  async function handleAutoDetect() {
    if (!mapState || !locations.length) return;
    setDetecting(true);
    setDetectError(null);
    setSuggestions(null);
    try {
      const { dataUrl: imageDataUrl, width: imageWidth, height: imageHeight } = await resizeDataUrl(mapState.imageDataUrl, 1024);
      const res = await fetch('/api/detect-pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl,
          imageWidth,
          imageHeight,
          locations: locations.map(([name]) => name).filter(isPlaceName),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Detection failed');
      const found: Record<string, LocationPin> = data.pins ?? {};
      if (Object.keys(found).length === 0) {
        setDetectError('No location labels found on the map. Try placing pins manually.');
      } else {
        setSuggestions(found);
      }
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  }

  function acceptSuggestion(name: string) {
    if (!mapState || !suggestions) return;
    onMapStateChange({ imageDataUrl: mapState.imageDataUrl, pins: { ...mapState.pins, [name]: suggestions[name] } });
    const remaining = { ...suggestions };
    delete remaining[name];
    setSuggestions(Object.keys(remaining).length ? remaining : null);
  }

  function acceptAllSuggestions() {
    if (!mapState || !suggestions) return;
    onMapStateChange({ imageDataUrl: mapState.imageDataUrl, pins: { ...mapState.pins, ...suggestions } });
    setSuggestions(null);
  }

  function dismissSuggestion(name: string) {
    if (!suggestions) return;
    const remaining = { ...suggestions };
    delete remaining[name];
    setSuggestions(Object.keys(remaining).length ? remaining : null);
  }

  // ── No-image state: show subway map with upload overlay ───────────────────────
  if (!mapState) {
    const searchQuery = encodeURIComponent(`${bookTitle ?? ''} map`.trim());
    const searchUrl = `https://www.google.com/search?tbm=isch&q=${searchQuery}`;

    const selectedChar = selectedCharName ? characters.find((c) => c.name === selectedCharName) : undefined;
    return (
      <>
      {selectedChar && (
        <CharacterModal character={selectedChar} snapshots={snapshots} onClose={() => setSelectedCharName(null)} />
      )}
      {selectedLocationName && (
        <LocationModal locationName={selectedLocationName} snapshots={snapshots} onClose={() => setSelectedLocationName(null)} />
      )}
      {selectedArcName && (
        <NarrativeArcModal arcName={selectedArcName} snapshots={snapshots} onClose={() => setSelectedArcName(null)} />
      )}
      <div
        className={`relative h-full min-h-0 rounded-xl border overflow-hidden ${isDragging ? 'border-amber-500/40' : 'border-stone-200 dark:border-zinc-800'}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {/* Subway map fills full height */}
        <div className="h-full bg-white dark:bg-zinc-900">
          <SubwayMap snapshots={snapshots} currentCharacters={displayedChars} onCharacterClick={setSelectedCharName} onLocationClick={setSelectedLocationName} onArcClick={setSelectedArcName} />
        </div>

        {/* Filter panel — bottom-left overlay */}
        {characters.length > 0 && (
          <div className="absolute bottom-3 left-3 z-10">
            {filterOpen ? (
              <div className="bg-white/95 dark:bg-zinc-900/95 border border-stone-300 dark:border-zinc-700 rounded-xl shadow-2xl backdrop-blur-sm p-3 flex flex-col gap-2 w-52 max-h-80">
                <div className="flex items-center justify-between flex-shrink-0">
                  <p className="text-xs font-semibold text-stone-700 dark:text-zinc-300">Track characters</p>
                  <button onClick={() => setFilterOpen(false)} className="text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 text-xs">✕</button>
                </div>
                <ArcPills />
                <input
                  type="search"
                  placeholder="Search…"
                  value={charFilterQ}
                  onChange={(e) => setCharFilterQ(e.target.value)}
                  className="flex-shrink-0 w-full text-xs px-2 py-1 rounded-lg border outline-none bg-stone-100 dark:bg-zinc-800 border-stone-300 dark:border-zinc-700 text-stone-700 dark:text-zinc-300 placeholder-stone-400 dark:placeholder-zinc-600 focus:border-stone-400 dark:focus:border-zinc-500"
                />
                <div className="flex gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => { setTrackedCharNames(null); setSelectedArc(null); }}
                    className="text-[10px] px-2 py-0.5 rounded border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 hover:border-stone-400 dark:hover:border-zinc-600 transition-colors"
                  >All</button>
                  <button
                    onClick={() => { setTrackedCharNames(new Set()); setSelectedArc(null); }}
                    className="text-[10px] px-2 py-0.5 rounded border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 hover:border-stone-400 dark:hover:border-zinc-600 transition-colors"
                  >None</button>
                </div>
                <ul className="overflow-y-auto space-y-0.5 flex-1 min-h-0">
                  {sortedCharacters.filter((c) => !charFilterQ.trim() || c.name.toLowerCase().includes(charFilterQ.toLowerCase()) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(charFilterQ.toLowerCase()))).map((c) => {
                    const checked = trackedCharNames === null || trackedCharNames.has(c.name);
                    return (
                      <li key={c.name}>
                        <label className="flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleChar(c.name)}
                            className="accent-amber-500 w-3 h-3 flex-shrink-0"
                          />
                          <span className="text-xs text-stone-700 dark:text-zinc-300 truncate flex-1">{c.name}</span>
                          <span className="text-[9px] text-stone-400 dark:text-zinc-600 flex-shrink-0">{c.importance[0]}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {trackedCharNames !== null && (
                  <p className="text-[10px] text-stone-400 dark:text-zinc-600 text-center flex-shrink-0">
                    {trackedCharNames.size} of {characters.length} shown
                  </p>
                )}
              </div>
            ) : (
              <button
                onClick={() => setFilterOpen(true)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors backdrop-blur-sm shadow-lg ${
                  trackedCharNames !== null
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-400 hover:bg-amber-500/20'
                    : 'bg-stone-100/90 dark:bg-zinc-800/90 hover:bg-stone-200 dark:hover:bg-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 border-stone-300 dark:border-zinc-700'
                }`}
              >
                ⊙ {trackedCharNames !== null ? `${trackedCharNames.size}/${characters.length}` : 'Filter'}
              </button>
            )}
          </div>
        )}

        {/* Upload panel — bottom-right overlay */}
        <div className="absolute bottom-3 right-3 z-10">
          {showUploadPanel ? (
            <div className="bg-white/95 dark:bg-zinc-900/95 border border-stone-300 dark:border-zinc-700 rounded-xl shadow-2xl backdrop-blur-sm p-3.5 flex flex-col gap-2.5 w-64">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-stone-700 dark:text-zinc-300">Add a real map image</p>
                <button onClick={() => setShowUploadPanel(false)} className="text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 text-xs">✕</button>
              </div>

              {/* Drop zone */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className={`h-20 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors ${
                  isDragging ? 'border-amber-500 bg-amber-500/5 text-amber-400' : 'border-stone-300 dark:border-zinc-700 hover:border-stone-400 dark:hover:border-zinc-600 hover:bg-stone-100/40 dark:hover:bg-zinc-800/40 text-stone-400 dark:text-zinc-500'
                }`}
              >
                <span className="text-base opacity-50">↑</span>
                <p className="text-[10px]">Drop / click to upload</p>
              </div>

              {/* URL input */}
              <div className="flex gap-1.5">
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => { setUrlInput(e.target.value); setUrlError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadFromUrl(urlInput); }}
                  placeholder="Or paste image URL…"
                  className="flex-1 min-w-0 bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-stone-800 dark:text-zinc-200 placeholder-stone-400 dark:placeholder-zinc-600 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500"
                />
                <button
                  onClick={() => loadFromUrl(urlInput)}
                  disabled={urlLoading || !urlInput.trim()}
                  className="px-2.5 py-1.5 rounded-lg bg-amber-500 text-zinc-900 text-xs font-semibold hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                >
                  {urlLoading ? '…' : 'Load'}
                </button>
              </div>
              {urlError && <p className="text-xs text-red-500">{urlError}</p>}

              <a
                href={searchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-center text-[10px] text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 transition-colors"
              >
                Search "{bookTitle ?? ''} map" in Google Images ↗
              </a>
            </div>
          ) : (
            <button
              onClick={() => setShowUploadPanel(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-stone-100/90 dark:bg-zinc-800/90 hover:bg-stone-200 dark:hover:bg-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 text-xs font-medium rounded-lg border border-stone-300 dark:border-zinc-700 transition-colors backdrop-blur-sm shadow-lg"
            >
              <span className="text-[10px]">🗺️</span> Add map image
            </button>
          )}
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }} />
      </div>
      </>
    );
  }

  // ── Map view ──────────────────────────────────────────────────────────────────
  const pins = mapState.pins;
  const suggestionCount = suggestions ? Object.keys(suggestions).length : 0;
  const unplacedLocations = locations.filter(([name]) => !pins[name] && !suggestions?.[name]);

  return (
    <>
    {selectedLocationName && (
      <LocationModal locationName={selectedLocationName} snapshots={snapshots} onClose={() => setSelectedLocationName(null)} />
    )}
    {selectedCharName && (() => { const c = characters.find((ch) => ch.name === selectedCharName); return c ? <CharacterModal character={c} snapshots={snapshots} onClose={() => setSelectedCharName(null)} /> : null; })()}
    <div className="flex gap-4 h-full min-h-0">
      {/* Map area */}
      <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <p className="text-xs text-stone-400 dark:text-zinc-600">
            {pinnedCount} of {locations.length} locations pinned
          </p>
          {pinnedCount > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg overflow-hidden border border-stone-300 dark:border-zinc-700 text-xs">
                {(['locations', 'characters'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => { setCharMode(mode === 'characters'); setActivePin(null); setActiveCharPin(null); }}
                    className={`px-2.5 py-1 transition-colors ${
                      (mode === 'characters') === charMode
                        ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100'
                        : 'bg-transparent text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
                    }`}
                  >
                    {mode === 'locations' ? 'Locations' : 'Characters'}
                  </button>
                ))}
              </div>
              {charMode && characters.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setFilterOpen((v) => !v)}
                    className={`text-xs px-2 py-1 rounded-lg border transition-colors ${
                      trackedCharNames !== null
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15'
                        : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 hover:border-stone-400 dark:hover:border-zinc-600'
                    }`}
                  >
                    ⊙ {trackedCharNames !== null ? `${trackedCharNames.size}/${characters.length}` : 'Filter'}
                  </button>
                  {filterOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white/95 dark:bg-zinc-900/95 border border-stone-300 dark:border-zinc-700 rounded-xl shadow-2xl backdrop-blur-sm p-3 flex flex-col gap-2 w-56 max-h-80 z-30">
                      <div className="flex items-center justify-between flex-shrink-0">
                        <p className="text-xs font-semibold text-stone-700 dark:text-zinc-300">Track characters</p>
                        <button onClick={() => setFilterOpen(false)} className="text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 text-xs">✕</button>
                      </div>
                      <ArcPills />
                      <input
                        type="search"
                        placeholder="Search…"
                        value={charFilterQ}
                        onChange={(e) => setCharFilterQ(e.target.value)}
                        className="flex-shrink-0 w-full text-xs px-2 py-1 rounded-lg border outline-none bg-stone-100 dark:bg-zinc-800 border-stone-300 dark:border-zinc-700 text-stone-700 dark:text-zinc-300 placeholder-stone-400 dark:placeholder-zinc-600 focus:border-stone-400 dark:focus:border-zinc-500"
                      />
                      <div className="flex gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => { setTrackedCharNames(null); setSelectedArc(null); }}
                          className="text-[10px] px-2 py-0.5 rounded border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 hover:border-stone-400 dark:hover:border-zinc-600 transition-colors"
                        >All</button>
                        <button
                          onClick={() => { setTrackedCharNames(new Set()); setSelectedArc(null); }}
                          className="text-[10px] px-2 py-0.5 rounded border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 hover:border-stone-400 dark:hover:border-zinc-600 transition-colors"
                        >None</button>
                      </div>
                      <ul className="overflow-y-auto space-y-0.5 flex-1 min-h-0">
                        {sortedCharacters.filter((c) => !charFilterQ.trim() || c.name.toLowerCase().includes(charFilterQ.toLowerCase()) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(charFilterQ.toLowerCase()))).map((c) => {
                          const checked = trackedCharNames === null || trackedCharNames.has(c.name);
                          return (
                            <li key={c.name}>
                              <label className="flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleChar(c.name)}
                                  className="accent-amber-500 w-3 h-3 flex-shrink-0"
                                />
                                <span className="text-xs text-stone-700 dark:text-zinc-300 truncate flex-1">{c.name}</span>
                                <span className="text-[9px] text-stone-400 dark:text-zinc-600 flex-shrink-0">{c.importance[0]}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      {trackedCharNames !== null && (
                        <p className="text-[10px] text-stone-400 dark:text-zinc-600 text-center flex-shrink-0">
                          {trackedCharNames.size} of {characters.length} shown
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex-1" />
          {placingLocation && (
            <span className="text-xs text-amber-400 font-medium animate-pulse">
              Click map to place "{placingLocation}" · ESC to cancel
            </span>
          )}
          {detectError && (
            <span className="text-xs text-red-500">{detectError}</span>
          )}
          {locations.length > 0 && !detecting && !placingLocation && (
            <button
              onClick={handleAutoDetect}
              className="text-xs px-2.5 py-1 rounded-lg border border-violet-700/50 text-violet-400 hover:bg-violet-500/10 hover:border-violet-600 transition-colors font-medium"
            >
              ✦ Auto-detect
            </button>
          )}
          {detecting && (
            <span className="flex items-center gap-1.5 text-xs text-violet-400">
              <span className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin" />
              Scanning map…
            </span>
          )}
          <button
            onClick={async () => {
              const { width, height } = await resizeDataUrl(mapState.imageDataUrl, 1024);
              const data = JSON.stringify({ imageWidth: width, imageHeight: height, pins: mapState.pins }, null, 2);
              await navigator.clipboard.writeText(data);
              alert('Pin debug data copied to clipboard.');
            }}
            className="text-xs text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 transition-colors"
          >
            Copy debug data
          </button>
          {pinnedCount > 0 && !placingLocation && (
            <button
              onClick={() => { if (confirm('Clear all pin placements?')) onMapStateChange({ ...mapState, pins: {} }); }}
              className="text-xs text-stone-400 dark:text-zinc-600 hover:text-red-400 transition-colors"
            >
              Clear pins
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 transition-colors"
          >
            Replace map
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }} />
        </div>

        {/* Suggestions banner */}
        {suggestions && suggestionCount > 0 && (
          <div className="flex-shrink-0 flex items-center gap-3 px-3 py-2 bg-violet-500/10 border border-violet-500/20 rounded-xl">
            <span className="text-xs text-violet-300 font-medium">
              ✦ {suggestionCount} location{suggestionCount !== 1 ? 's' : ''} detected
            </span>
            <button
              onClick={acceptAllSuggestions}
              className="text-xs px-2.5 py-1 rounded-lg bg-violet-500 text-white font-medium hover:bg-violet-400 transition-colors"
            >
              Accept all
            </button>
            <button
              onClick={() => setSuggestions(null)}
              className="text-xs text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 transition-colors ml-auto"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Map + pins */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-xl">
        <div
          ref={mapRef}
          onClick={handleMapClick}
          onPointerMove={handleMapPointerMove}
          onPointerUp={handleMapPointerUp}
          onPointerCancel={() => setDragState(null)}
          className={`relative border border-stone-200 dark:border-zinc-800 overflow-hidden select-none ${dragState ? 'cursor-grabbing' : placingLocation ? 'cursor-crosshair' : 'cursor-default'}`}
        >
          <img src={mapState.imageDataUrl} alt="Map" className="w-full block" draggable={false} />

          {/* Placement overlay */}
          {placingLocation && (
            <div className="absolute inset-0 bg-amber-500/5 border-2 border-amber-500/30 border-dashed pointer-events-none" />
          )}

          {/* Character cluster pins (char mode) — rendered flat so keys persist across
              snapshot changes and CSS transitions animate position smoothly */}
          {charMode && (() => {
            // Build flat list: { char, location, px, py } for every character at a pinned location
            const mapRect = mapRef.current?.getBoundingClientRect();
            const mapW = mapRect?.width ?? 800;
            const mapH = mapRect?.height ?? 600;
            const charPins: { char: Character; location: string; px: number; py: number }[] = [];
            for (const [location, { x, y }] of Object.entries(pins)) {
              const chars = displayedLocationMap.get(location) ?? [];
              if (chars.length === 0) continue;
              const positions = clusterPositions(chars.length, x, y, mapW, mapH);
              chars.forEach((char, i) => charPins.push({
                char,
                location,
                px: positions[i].x,
                py: positions[i].y,
              }));
            }
            return (
              <>
                {/* Faint anchor dots */}
                {Object.entries(pins).map(([location, { x, y }]) => {
                  const hasChars = (displayedLocationMap.get(location) ?? []).length > 0;
                  if (!hasChars) return null;
                  const locColor = pinColor(location);
                  return (
                    <div key={`anchor-${location}`} style={{ position: 'absolute', left: `${x}%`, top: `${y}%` }} className="pointer-events-none z-[5]">
                      <div className="w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2 border border-white/20" style={{ backgroundColor: `${locColor}40` }} />
                    </div>
                  );
                })}
                {/* Character pins — keyed by name so the element persists when position changes */}
                {charPins.map(({ char, location, px, py }, globalIdx) => {
                  const color = charImportanceColor(char.importance);
                  const isActive = activeCharPin === char.name;
                  return (
                    <div
                      key={char.name}
                      style={{
                        position: 'absolute',
                        left: `${px}%`,
                        top: `${py}%`,
                        transition: `left 0.8s cubic-bezier(0.4,0,0.2,1) ${globalIdx * 25}ms, top 0.8s cubic-bezier(0.4,0,0.2,1) ${globalIdx * 25}ms`,
                      }}
                      className="z-10"
                      onClick={(e) => { e.stopPropagation(); setActiveCharPin(isActive ? null : char.name); }}
                    >
                      <div className="relative -translate-x-1/2 -translate-y-1/2" style={{ pointerEvents: 'all' }}>
                        <div
                          title={char.name}
                          className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white cursor-pointer shadow-md hover:scale-110 transition-transform border-2 border-zinc-900"
                          style={{ backgroundColor: color }}
                        >
                          {initials(char.name)}
                        </div>
                        {isActive && (
                          <div
                            className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-white dark:bg-zinc-900 border border-stone-300 dark:border-zinc-700 rounded-xl shadow-2xl p-3 min-w-44 z-20 pointer-events-auto"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <div className="w-5 h-5 rounded-md flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0" style={{ backgroundColor: color }}>{initials(char.name)}</div>
                              <p className="text-xs text-stone-800 dark:text-zinc-200 font-semibold truncate">{char.name}</p>
                            </div>
                            <p className="text-[10px] text-stone-400 dark:text-zinc-500">{char.importance} · {char.status}</p>
                            <p className="text-[10px] text-stone-400 dark:text-zinc-600 mt-1 truncate">{location}</p>
                            {char.recentEvents && <p className="text-[10px] text-stone-400 dark:text-zinc-500 mt-1 line-clamp-2">{char.recentEvents}</p>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            );
          })()}

          {/* Accepted pins */}
          {!charMode && Object.entries(pins).map(([location, pinPos]) => {
            const { x, y } = dragState?.name === location ? dragState : pinPos;
            const chars = locationMap.get(location) ?? [];
            const color = pinColor(location);
            const isActive = activePin === location;
            const isDraggingThis = dragState?.name === location;
            return (
              <div
                key={location}
                style={{ position: 'absolute', left: `${x}%`, top: `${y}%` }}
                className={`z-10 ${isDraggingThis ? 'z-20' : ''}`}
                onClick={(e) => { e.stopPropagation(); if (!wasDraggingRef.current) setActivePin(isActive ? null : location); }}
              >
                <div
                  className="relative -translate-x-1/2 -translate-y-full flex flex-col items-center"
                  style={{ pointerEvents: 'all', touchAction: 'none' }}
                  onPointerDown={(e) => handlePinPointerDown(e, location)}
                >
                  <div
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white shadow-lg whitespace-nowrap transition-all ${isDraggingThis ? 'cursor-grabbing scale-110' : 'cursor-grab hover:brightness-110'}`}
                    style={{ backgroundColor: color, boxShadow: `0 2px 8px ${color}60` }}
                  >
                    {location}{chars.length > 0 && <span className="ml-1 opacity-75">· {chars.length}</span>}
                  </div>
                  <div className="w-px h-2.5" style={{ backgroundColor: color }} />
                  <div className="w-2 h-2 rounded-full border-2 border-white/50" style={{ backgroundColor: color }} />

                  {isActive && (
                    <div
                      className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white dark:bg-zinc-900 border border-stone-300 dark:border-zinc-700 rounded-xl shadow-2xl p-3 min-w-44 z-20"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <button
                          onClick={() => { setSelectedLocationName(location); setActivePin(null); }}
                          className="text-[10px] font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-left"
                        >{location}</button>
                        <button
                          onClick={() => { removePin(location); setActivePin(null); }}
                          className="text-[10px] text-stone-300 dark:text-zinc-700 hover:text-red-500 transition-colors ml-2"
                          title="Remove pin"
                        >✕</button>
                      </div>
                      {chars.length === 0 ? (
                        <p className="text-xs text-stone-400 dark:text-zinc-600">No characters here</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {chars.map((ch) => (
                            <li key={ch.name} className="flex items-center gap-2">
                              <div className="w-5 h-5 rounded-md bg-stone-100 dark:bg-zinc-800 flex items-center justify-center text-[9px] font-bold text-stone-500 dark:text-zinc-400 flex-shrink-0">
                                {initials(ch.name)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs text-stone-800 dark:text-zinc-200 font-medium truncate">{ch.name}</p>
                                {ch.importance === 'main' && <p className="text-[9px] text-amber-500/70">main</p>}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        onClick={() => { setPlacingLocation(location); setActivePin(null); }}
                        className="mt-2 w-full text-[10px] text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 transition-colors text-center"
                      >
                        Move pin
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Suggestion ghost pins */}
          {!charMode && suggestions && Object.entries(suggestions).map(([location, { x, y }]) => (
            <div
              key={`suggestion-${location}`}
              style={{ position: 'absolute', left: `${x}%`, top: `${y}%` }}
              className="z-10"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative -translate-x-1/2 -translate-y-full flex flex-col items-center pointer-events-all">
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-violet-300 whitespace-nowrap border border-dashed border-violet-500/60 bg-white/80 dark:bg-zinc-900/80 shadow-lg">
                  <span className="opacity-60">✦</span>
                  {location}
                  <button
                    onClick={() => acceptSuggestion(location)}
                    className="ml-1 text-violet-300 hover:text-white transition-colors"
                    title="Accept"
                  >✓</button>
                  <button
                    onClick={() => dismissSuggestion(location)}
                    className="text-stone-400 dark:text-zinc-600 hover:text-red-400 transition-colors"
                    title="Dismiss"
                  >✕</button>
                </div>
                <div className="w-px h-2.5 bg-violet-500/50 border-dashed" />
                <div className="w-2 h-2 rounded-full border-2 border-dashed border-violet-500/60 bg-violet-500/20" />
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>

      {/* Location sidebar */}
      <div className="w-52 flex-shrink-0 flex flex-col min-h-0">
        {/* Suggestions review list */}
        {suggestions && suggestionCount > 0 && (
          <div className="mb-4 flex-shrink-0">
            <p className="text-xs font-medium text-violet-400 uppercase tracking-wider mb-2">Detected</p>
            <ul className="space-y-1">
              {Object.entries(suggestions).map(([name]) => {
                const color = pinColor(name);
                return (
                  <li key={name} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-violet-500/20 bg-violet-500/5">
                    <span className="text-[8px]" style={{ color }}>●</span>
                    <span className="flex-1 text-xs text-violet-300 truncate">{name}</span>
                    <button onClick={() => acceptSuggestion(name)} className="text-[10px] text-stone-400 dark:text-zinc-500 hover:text-violet-300 transition-colors" title="Accept">✓</button>
                    <button onClick={() => dismissSuggestion(name)} className="text-[10px] text-stone-300 dark:text-zinc-700 hover:text-red-400 transition-colors" title="Dismiss">✕</button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-2 flex-shrink-0">
          {unplacedLocations.length > 0 ? `Unplaced (${unplacedLocations.length})` : 'Locations'}
        </p>

        {locations.length === 0 ? (
          <p className="text-xs text-stone-300 dark:text-zinc-700">No locations found — analyze a chapter first.</p>
        ) : (
          <ul className="space-y-1 overflow-y-auto flex-1">
            {locations.map(([name, chars]) => {
              const pin = pins[name];
              const isSuggested = !!suggestions?.[name];
              const isPlacing = placingLocation === name;
              const color = pinColor(name);
              if (pin && !suggestions) return null; // hide already-pinned when not reviewing

              return (
                <li key={name}>
                  <button
                    onClick={() => !isSuggested && setPlacingLocation(isPlacing ? null : name)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors border ${
                      isSuggested
                        ? 'border-violet-500/20 bg-violet-500/5 text-violet-400 cursor-default'
                        : isPlacing
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                        : pin
                        ? 'border-stone-200 dark:border-zinc-800 bg-stone-100/20 dark:bg-zinc-800/20 text-stone-700 dark:text-zinc-300 hover:border-stone-300 dark:hover:border-zinc-700'
                        : 'border-stone-200/40 dark:border-zinc-800/40 text-stone-400 dark:text-zinc-600 hover:border-stone-300 dark:hover:border-zinc-700 hover:text-stone-400 dark:hover:text-zinc-500'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-shrink-0 text-[8px]" style={{ color }}>
                        {isSuggested ? '✦' : '●'}
                      </span>
                      <span className="flex-1 truncate font-medium">{name}</span>
                      <span className="flex-shrink-0 text-stone-400 dark:text-zinc-600">{chars.length}</span>
                    </div>
                    <p className="text-[10px] mt-0.5 ml-3.5 text-stone-300 dark:text-zinc-700">
                      {isSuggested ? 'Detected — accept or dismiss' : isPlacing ? 'Click map to place…' : pin ? 'Pinned · click to move' : 'Click to place'}
                    </p>
                  </button>
                </li>
              );
            })}
            {/* Show pinned locations at bottom when not reviewing */}
            {!suggestions && locations.filter(([n]) => pins[n]).map(([name, chars]) => {
              const color = pinColor(name);
              return (
                <li key={`pinned-${name}`}>
                  <button
                    onClick={() => setPlacingLocation(placingLocation === name ? null : name)}
                    className="w-full text-left px-2.5 py-2 rounded-lg text-xs border border-stone-200 dark:border-zinc-800 bg-stone-100/20 dark:bg-zinc-800/20 text-stone-500 dark:text-zinc-400 hover:border-stone-300 dark:hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-shrink-0 text-[8px]" style={{ color }}>●</span>
                      <span className="flex-1 truncate font-medium">{name}</span>
                      <span className="flex-shrink-0 text-stone-400 dark:text-zinc-600">{chars.length}</span>
                    </div>
                    <p className="text-[10px] mt-0.5 ml-3.5 text-stone-300 dark:text-zinc-700">Pinned · click to move</p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {pinnedCount > 0 && !suggestions && (
          <div className="mt-4 pt-3 border-t border-stone-200 dark:border-zinc-800 flex-shrink-0">
            <p className="text-[10px] text-stone-300 dark:text-zinc-700">Click a pin to see characters. ESC cancels placement.</p>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
