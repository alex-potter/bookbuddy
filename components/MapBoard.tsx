'use client';

import { useEffect, useRef, useState } from 'react';
import type { Character, LocationPin, MapState } from '@/types';

interface Props {
  characters: Character[];
  bookTitle?: string;
  mapState: MapState | null;
  onMapStateChange: (state: MapState) => void;
}

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

  const result = new Map<string, Character[]>();
  for (const { canonical, chars } of groups.values()) result.set(canonical, chars);
  return new Map([...result.entries()].sort((a, b) => b[1].length - a[1].length));
}

export default function MapBoard({ characters, bookTitle, mapState, onMapStateChange }: Props) {
  const [placingLocation, setPlacingLocation] = useState<string | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadTab, setUploadTab] = useState<'drop' | 'url'>('drop');
  const [urlInput, setUrlInput] = useState('');
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Auto-detect state
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, LocationPin> | null>(null); // null = no pending review

  const [dragState, setDragState] = useState<{ name: string; x: number; y: number } | null>(null);
  const wasDraggingRef = useRef(false);

  const mapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const locationMap = buildLocationMap(characters);
  const locations = [...locationMap.entries()];
  const pinnedCount = mapState ? Object.keys(mapState.pins).length : 0;

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

  // ── Upload prompt ─────────────────────────────────────────────────────────────
  if (!mapState) {
    const searchQuery = encodeURIComponent(`${bookTitle ?? ''} map`.trim());
    const searchUrl = `https://www.google.com/search?tbm=isch&q=${searchQuery}`;

    return (
      <div className="flex flex-col items-center justify-center h-full gap-5">
        <div className="text-4xl opacity-20">🗺</div>
        <div className="text-center">
          <p className="text-zinc-300 font-medium mb-1">Add a map</p>
          <p className="text-sm text-zinc-600">Place character pins on an image of the world.</p>
        </div>

        {/* Tabs */}
        <div className="w-full max-w-sm">
          <div className="flex rounded-lg overflow-hidden border border-zinc-700 mb-3">
            {(['drop', 'url'] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setUploadTab(t); setUrlError(null); }}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  uploadTab === t ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t === 'drop' ? 'File / drag' : 'Image URL'}
              </button>
            ))}
          </div>

          {uploadTab === 'drop' ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`h-32 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${
                isDragging ? 'border-amber-500 bg-amber-500/5 text-amber-400' : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/30 text-zinc-500'
              }`}
            >
              <span className="text-xl opacity-50">↑</span>
              <p className="text-xs">Drop a file or image from your browser</p>
              <p className="text-[10px] text-zinc-700">or click to browse files</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => { setUrlInput(e.target.value); setUrlError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadFromUrl(urlInput); }}
                  placeholder="https://example.com/map.jpg"
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                />
                <button
                  onClick={() => loadFromUrl(urlInput)}
                  disabled={urlLoading || !urlInput.trim()}
                  className="px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 text-xs font-semibold hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                >
                  {urlLoading ? '…' : 'Load'}
                </button>
              </div>
              {urlError && <p className="text-xs text-red-500">{urlError}</p>}
              <p className="text-[10px] text-zinc-700">Right-click any image online → "Copy image address", then paste here</p>
            </div>
          )}
        </div>

        {/* Search launcher */}
        <div className="text-center">
          <p className="text-xs text-zinc-700 mb-2">Need to find a map?</p>
          <a
            href={searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300 transition-colors"
          >
            Search "{bookTitle ?? ''} map" in Google Images ↗
          </a>
          <p className="text-[10px] text-zinc-700 mt-1.5">Then drag the image here, or copy its URL to the URL tab</p>
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }} />
      </div>
    );
  }

  // ── Map view ──────────────────────────────────────────────────────────────────
  const pins = mapState.pins;
  const suggestionCount = suggestions ? Object.keys(suggestions).length : 0;
  const unplacedLocations = locations.filter(([name]) => !pins[name] && !suggestions?.[name]);

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Map area */}
      <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <p className="text-xs text-zinc-600">
            {pinnedCount} of {locations.length} locations pinned
          </p>
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
          {pinnedCount > 0 && !placingLocation && (
            <button
              onClick={() => { if (confirm('Clear all pin placements?')) onMapStateChange({ ...mapState, pins: {} }); }}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            >
              Clear pins
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
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
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors ml-auto"
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
          className={`relative border border-zinc-800 overflow-hidden select-none ${dragState ? 'cursor-grabbing' : placingLocation ? 'cursor-crosshair' : 'cursor-default'}`}
        >
          <img src={mapState.imageDataUrl} alt="Map" className="w-full block" draggable={false} />

          {/* Placement overlay */}
          {placingLocation && (
            <div className="absolute inset-0 bg-amber-500/5 border-2 border-amber-500/30 border-dashed pointer-events-none" />
          )}

          {/* Accepted pins */}
          {Object.entries(pins).map(([location, pinPos]) => {
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
                      className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-3 min-w-44 z-20"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{location}</p>
                        <button
                          onClick={() => { removePin(location); setActivePin(null); }}
                          className="text-[10px] text-zinc-700 hover:text-red-500 transition-colors ml-2"
                          title="Remove pin"
                        >✕</button>
                      </div>
                      {chars.length === 0 ? (
                        <p className="text-xs text-zinc-600">No characters here</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {chars.map((ch) => (
                            <li key={ch.name} className="flex items-center gap-2">
                              <div className="w-5 h-5 rounded-md bg-zinc-800 flex items-center justify-center text-[9px] font-bold text-zinc-400 flex-shrink-0">
                                {initials(ch.name)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs text-zinc-200 font-medium truncate">{ch.name}</p>
                                {ch.importance === 'main' && <p className="text-[9px] text-amber-500/70">main</p>}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <button
                        onClick={() => { setPlacingLocation(location); setActivePin(null); }}
                        className="mt-2 w-full text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors text-center"
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
          {suggestions && Object.entries(suggestions).map(([location, { x, y }]) => (
            <div
              key={`suggestion-${location}`}
              style={{ position: 'absolute', left: `${x}%`, top: `${y}%` }}
              className="z-10"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative -translate-x-1/2 -translate-y-full flex flex-col items-center pointer-events-all">
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-violet-300 whitespace-nowrap border border-dashed border-violet-500/60 bg-zinc-900/80 shadow-lg">
                  <span className="opacity-60">✦</span>
                  {location}
                  <button
                    onClick={() => acceptSuggestion(location)}
                    className="ml-1 text-violet-300 hover:text-white transition-colors"
                    title="Accept"
                  >✓</button>
                  <button
                    onClick={() => dismissSuggestion(location)}
                    className="text-zinc-600 hover:text-red-400 transition-colors"
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
                    <button onClick={() => acceptSuggestion(name)} className="text-[10px] text-zinc-500 hover:text-violet-300 transition-colors" title="Accept">✓</button>
                    <button onClick={() => dismissSuggestion(name)} className="text-[10px] text-zinc-700 hover:text-red-400 transition-colors" title="Dismiss">✕</button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-2 flex-shrink-0">
          {unplacedLocations.length > 0 ? `Unplaced (${unplacedLocations.length})` : 'Locations'}
        </p>

        {locations.length === 0 ? (
          <p className="text-xs text-zinc-700">No locations found — analyze a chapter first.</p>
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
                        ? 'border-zinc-800 bg-zinc-800/20 text-zinc-300 hover:border-zinc-700'
                        : 'border-zinc-800/40 text-zinc-600 hover:border-zinc-700 hover:text-zinc-500'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-shrink-0 text-[8px]" style={{ color }}>
                        {isSuggested ? '✦' : '●'}
                      </span>
                      <span className="flex-1 truncate font-medium">{name}</span>
                      <span className="flex-shrink-0 text-zinc-600">{chars.length}</span>
                    </div>
                    <p className="text-[10px] mt-0.5 ml-3.5 text-zinc-700">
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
                    className="w-full text-left px-2.5 py-2 rounded-lg text-xs border border-zinc-800 bg-zinc-800/20 text-zinc-400 hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-shrink-0 text-[8px]" style={{ color }}>●</span>
                      <span className="flex-1 truncate font-medium">{name}</span>
                      <span className="flex-shrink-0 text-zinc-600">{chars.length}</span>
                    </div>
                    <p className="text-[10px] mt-0.5 ml-3.5 text-zinc-700">Pinned · click to move</p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {pinnedCount > 0 && !suggestions && (
          <div className="mt-4 pt-3 border-t border-zinc-800 flex-shrink-0">
            <p className="text-[10px] text-zinc-700">Click a pin to see characters. ESC cancels placement.</p>
          </div>
        )}
      </div>
    </div>
  );
}
