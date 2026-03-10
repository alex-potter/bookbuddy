'use client';

import { useEffect, useRef, useState } from 'react';
import type { Character, LocationPin, MapState } from '@/types';

interface Props {
  characters: Character[];
  mapState: MapState | null;
  onMapStateChange: (state: MapState) => void;
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

/** Derive unique locations → characters map, sorted by population */
function buildLocationMap(characters: Character[]): Map<string, Character[]> {
  const map = new Map<string, Character[]>();
  for (const ch of characters) {
    const loc = ch.currentLocation?.trim();
    if (!loc || loc === 'Unknown') continue;
    if (!map.has(loc)) map.set(loc, []);
    map.get(loc)!.push(ch);
  }
  return new Map([...map.entries()].sort((a, b) => b[1].length - a[1].length));
}

export default function MapBoard({ characters, mapState, onMapStateChange }: Props) {
  const [placingLocation, setPlacingLocation] = useState<string | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const locationMap = buildLocationMap(characters);
  const locations = [...locationMap.entries()];
  const pinnedCount = mapState ? Object.keys(mapState.pins).length : 0;

  // ESC cancels placement mode
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setPlacingLocation(null); }
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
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleImageFile(file);
  }

  function handleMapClick(e: React.MouseEvent<HTMLDivElement>) {
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

  // ── Upload prompt ────────────────────────────────────────────────────────────
  if (!mapState) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 py-16">
        <div className="text-5xl opacity-20">🗺</div>
        <div className="text-center">
          <p className="text-zinc-300 font-medium mb-1">Upload a map image</p>
          <p className="text-sm text-zinc-600 max-w-xs">
            PNG, JPG, or WEBP — place pins for each location to track where characters are.
          </p>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`w-72 h-36 rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${
            isDragging ? 'border-amber-500 bg-amber-500/5' : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/30'
          }`}
        >
          <span className="text-2xl opacity-40">↑</span>
          <p className="text-xs text-zinc-500">Drag & drop or click to browse</p>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }} />
      </div>
    );
  }

  // ── Map view ─────────────────────────────────────────────────────────────────
  const pins = mapState.pins;

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Map area */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        {/* Toolbar */}
        <div className="flex items-center gap-3">
          <p className="text-xs text-zinc-600">
            {pinnedCount} of {locations.length} locations pinned
          </p>
          <div className="flex-1" />
          {placingLocation && (
            <span className="text-xs text-amber-400 font-medium animate-pulse">
              Click map to place "{placingLocation}"
            </span>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Replace map
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }} />
        </div>

        {/* Map + pins */}
        <div
          ref={mapRef}
          onClick={handleMapClick}
          className={`relative rounded-xl border border-zinc-800 overflow-hidden select-none ${placingLocation ? 'cursor-crosshair' : 'cursor-default'}`}
        >
          <img src={mapState.imageDataUrl} alt="Map" className="w-full block" draggable={false} />

          {/* Placement overlay */}
          {placingLocation && (
            <div className="absolute inset-0 bg-amber-500/5 border-2 border-amber-500/30 border-dashed pointer-events-none" />
          )}

          {/* Pins */}
          {Object.entries(pins).map(([location, { x, y }]) => {
            const chars = locationMap.get(location) ?? [];
            const color = pinColor(location);
            const isActive = activePin === location;

            return (
              <div
                key={location}
                style={{ position: 'absolute', left: `${x}%`, top: `${y}%` }}
                className="z-10"
                onClick={(e) => { e.stopPropagation(); setActivePin(isActive ? null : location); }}
              >
                {/* Pin marker */}
                <div className="relative -translate-x-1/2 -translate-y-full flex flex-col items-center" style={{ pointerEvents: 'all' }}>
                  {/* Label */}
                  <div
                    className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white shadow-lg whitespace-nowrap cursor-pointer hover:brightness-110 transition-all"
                    style={{ backgroundColor: color, boxShadow: `0 2px 8px ${color}60` }}
                  >
                    {location}
                    {chars.length > 0 && (
                      <span className="ml-1 opacity-75">· {chars.length}</span>
                    )}
                  </div>
                  {/* Stem */}
                  <div className="w-px h-2.5" style={{ backgroundColor: color }} />
                  {/* Dot */}
                  <div className="w-2 h-2 rounded-full border-2 border-white/50" style={{ backgroundColor: color }} />

                  {/* Popup */}
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
                        >
                          ✕
                        </button>
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
                                {ch.importance === 'main' && (
                                  <p className="text-[9px] text-amber-500/70">main</p>
                                )}
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
        </div>
      </div>

      {/* Location sidebar */}
      <div className="w-52 flex-shrink-0 flex flex-col min-h-0">
        <p className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-3">Locations</p>

        {locations.length === 0 ? (
          <p className="text-xs text-zinc-700">No locations found — analyze a chapter first.</p>
        ) : (
          <ul className="space-y-1 overflow-y-auto flex-1">
            {locations.map(([name, chars]) => {
              const pin = pins[name];
              const isPlacing = placingLocation === name;
              const color = pinColor(name);

              return (
                <li key={name}>
                  <button
                    onClick={() => setPlacingLocation(isPlacing ? null : name)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors border ${
                      isPlacing
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                        : pin
                        ? 'border-zinc-800 bg-zinc-800/20 text-zinc-300 hover:border-zinc-700'
                        : 'border-zinc-800/40 text-zinc-600 hover:border-zinc-700 hover:text-zinc-500'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-shrink-0 text-[8px]" style={{ color }}>●</span>
                      <span className="flex-1 truncate font-medium">{name}</span>
                      <span className="flex-shrink-0 text-zinc-600">{chars.length}</span>
                    </div>
                    <p className="text-[10px] mt-0.5 ml-3.5" style={{ color: isPlacing ? undefined : pin ? '#52525b' : '#3f3f46' }}>
                      {isPlacing ? 'Click map to place…' : pin ? 'Pinned · click to move' : 'Click to place'}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Legend */}
        {pinnedCount > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800">
            <p className="text-[10px] text-zinc-700 mb-1">Click a pin on the map to see characters. ESC cancels placement.</p>
          </div>
        )}
      </div>
    </div>
  );
}
