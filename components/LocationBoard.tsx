'use client';

import { useRef, useState } from 'react';
import type { Character, LocationInfo, Snapshot } from '@/types';
import LocationGraph from './LocationGraph';
import SubwayMap from './SubwayMap';
import CharacterModal from './CharacterModal';
import { withResolvedLocations } from '@/lib/resolve-locations';

interface LocationGroup {
  location: string;
  characters: Character[];
  description?: string;
}

const STATUS_DOT: Record<Character['status'], string> = {
  alive: 'bg-emerald-400',
  dead: 'bg-red-400',
  unknown: 'bg-stone-400 dark:bg-zinc-500',
  uncertain: 'bg-amber-400',
};

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

function nameColor(name: string): string {
  const colors = [
    'bg-rose-500/15 text-rose-400',
    'bg-sky-500/15 text-sky-400',
    'bg-violet-500/15 text-violet-400',
    'bg-emerald-500/15 text-emerald-400',
    'bg-amber-500/15 text-amber-400',
    'bg-pink-500/15 text-pink-400',
    'bg-teal-500/15 text-teal-400',
    'bg-indigo-500/15 text-indigo-400',
  ];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return colors[Math.abs(hash) % colors.length];
}

interface Props {
  characters: Character[];
  locations?: LocationInfo[];
  bookTitle?: string;
  snapshots?: Snapshot[];
  chapterTitles?: string[];
  locationImage?: string;
  locationLabel?: string;
  onLocationImageChange?: (image: string | null, label: string) => void;
}

/** Build a per-location timeline from snapshot history */
function buildLocationTimeline(
  locationName: string,
  snapshots: Snapshot[],
  chapterTitles?: string[],
): Array<{ index: number; chapterTitle: string; events: string; characters: string[] }> {
  const norm = (s: string) => s.toLowerCase().trim();
  const target = norm(locationName);
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  const entries = [];
  for (const snap of sorted) {
    const locEntry = (snap.result.locations ?? []).find((l) => norm(l.name) === target);
    const charsHere = snap.result.characters
      .filter((c) => norm(c.currentLocation ?? '') === target)
      .map((c) => c.name);
    if (!locEntry?.recentEvents && charsHere.length === 0) continue;
    entries.push({
      index: snap.index,
      chapterTitle: chapterTitles?.[snap.index] ?? `Chapter ${snap.index + 1}`,
      events: locEntry?.recentEvents ?? '',
      characters: charsHere,
    });
  }
  return entries;
}

export default function LocationBoard({ characters, locations, bookTitle, snapshots = [], chapterTitles, locationImage, locationLabel = '', onLocationImageChange }: Props) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [search, setSearch] = useState('');
  const [expandedLocation, setExpandedLocation] = useState<string | null>(null);
  const [selectedCharName, setSelectedCharName] = useState<string | null>(null);
  const mapImage = locationImage ?? null;
  const mapLabel = locationLabel;
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const locationDescMap = new Map((locations ?? []).map((l) => [l.name.toLowerCase(), l.description]));
  const locationRelMap = new Map((locations ?? []).map((l) => [l.name.toLowerCase(), l.relationships ?? []]));
  const locationAliasMap = new Map((locations ?? []).map((l) => [l.name.toLowerCase(), l.aliases ?? []]));

  const resolvedCharacters = withResolvedLocations(characters, snapshots);

  const groups: LocationGroup[] = [];
  const seen = new Map<string, Character[]>();
  for (const c of resolvedCharacters) {
    const loc = c.currentLocation?.trim() || 'Unknown';
    if (!seen.has(loc)) seen.set(loc, []);
    seen.get(loc)!.push(c);
  }
  for (const [loc, chars] of seen.entries()) {
    const description = locationDescMap.get(loc.toLowerCase());
    groups.push({ location: loc, characters: chars, description });
  }
  groups.sort((a, b) => {
    if (a.location === 'Unknown') return 1;
    if (b.location === 'Unknown') return -1;
    return b.characters.length - a.characters.length;
  });

  function setImage(image: string | null, label: string) {
    onLocationImageChange?.(image, label);
  }

  function loadFile(file: File) {
    const label = file.name.replace(/\.[^.]+$/, '');
    const reader = new FileReader();
    reader.onload = (ev) => { setImage(ev.target?.result as string, label); setShowUploadPanel(false); };
    reader.readAsDataURL(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith('image/')) {
      loadFile(file);
    } else {
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (url?.match(/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)/i)) {
        setImage(url, 'Map');
        setShowUploadPanel(false);
      }
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const imageFile = Array.from(e.clipboardData.items)
      .find((item) => item.type.startsWith('image/'))
      ?.getAsFile();
    if (imageFile) { loadFile(imageFile); return; }
    const text = e.clipboardData.getData('text');
    if (text?.startsWith('http')) { setImage(text, 'Map'); setShowUploadPanel(false); }
  }

  function handleUrlSubmit() {
    if (urlInput.trim()) {
      setImage(urlInput.trim(), 'Map');
      setUrlInput('');
      setShowUrlInput(false);
      setShowUploadPanel(false);
    }
  }

  const selectedChar = selectedCharName ? characters.find((c) => c.name === selectedCharName) : undefined;

  return (
    <div className="space-y-4">
      {selectedChar && (
        <CharacterModal character={selectedChar} snapshots={snapshots} onClose={() => setSelectedCharName(null)} />
      )}
      {/* View toggle */}
      <div className="flex gap-1 bg-stone-100/50 dark:bg-zinc-800/50 rounded-lg p-0.5 w-fit border border-stone-200 dark:border-zinc-800">
        <button
          onClick={() => setView('list')}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            view === 'list' ? 'bg-stone-200 dark:bg-zinc-700 text-stone-800 dark:text-zinc-200' : 'text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
          }`}
        >
          List
        </button>
        <button
          onClick={() => setView('graph')}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            view === 'graph' ? 'bg-stone-200 dark:bg-zinc-700 text-stone-800 dark:text-zinc-200' : 'text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
          }`}
        >
          Graph
        </button>
      </div>

      {view === 'graph' && <LocationGraph snapshots={snapshots} currentCharacters={characters} />}

      {view === 'list' && (
        <>
          {/* Map section */}
          <div
            className={`bg-white dark:bg-zinc-900 rounded-xl border overflow-hidden relative ${
              dragging ? 'border-amber-500/40' : 'border-stone-200 dark:border-zinc-800'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onPaste={handlePaste}
            tabIndex={0}
            style={{ outline: 'none' }}
          >
            {mapImage ? (
              <>
                <img src={mapImage} alt={mapLabel || 'Book map'} className="w-full max-h-80 object-contain bg-stone-50 dark:bg-zinc-950" />
                {mapLabel && (
                  <p className="text-xs text-center text-stone-400 dark:text-zinc-600 py-2 border-t border-stone-200 dark:border-zinc-800">{mapLabel}</p>
                )}
                <button
                  onClick={() => setImage(null, '')}
                  className="absolute top-2 right-2 bg-white/80 dark:bg-zinc-900/80 hover:bg-white dark:hover:bg-zinc-900 text-stone-500 dark:text-zinc-400 hover:text-red-400 rounded-lg w-7 h-7 flex items-center justify-center text-sm transition-colors border border-stone-300 dark:border-zinc-700"
                  title="Remove map"
                >
                  ✕
                </button>
              </>
            ) : (
              <>
                {/* Subway map fills the card */}
                <div className="h-64 sm:h-72">
                  <SubwayMap snapshots={snapshots} currentCharacters={characters} />
                </div>

                {/* Upload overlay button — bottom-right */}
                <div className="absolute bottom-2 right-2">
                  {showUploadPanel ? (
                    <div className="bg-white dark:bg-zinc-900 border border-stone-300 dark:border-zinc-700 rounded-xl shadow-xl p-3 flex flex-col gap-2 min-w-44">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs font-medium text-stone-500 dark:text-zinc-400">Add book map</span>
                        <button onClick={() => setShowUploadPanel(false)} className="text-stone-400 dark:text-zinc-600 hover:text-stone-500 dark:hover:text-zinc-400 text-xs">✕</button>
                      </div>
                      <label
                        htmlFor="map-upload"
                        className="px-3 py-1.5 bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 text-xs font-medium rounded-lg cursor-pointer hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors border border-stone-300 dark:border-zinc-700 text-center"
                      >
                        Upload file
                      </label>
                      {bookTitle && (
                        <a
                          href={`https://www.google.com/search?q=${encodeURIComponent(bookTitle + ' map')}&tbm=isch`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 text-xs font-medium rounded-lg hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors border border-stone-300 dark:border-zinc-700 text-center"
                        >
                          Search Google Images
                        </a>
                      )}
                      <button
                        onClick={() => setShowUrlInput((v) => !v)}
                        className="px-3 py-1.5 bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 text-xs font-medium rounded-lg hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors border border-stone-300 dark:border-zinc-700"
                      >
                        Paste URL
                      </button>
                      {showUrlInput && (
                        <div className="flex gap-1.5">
                          <input
                            type="url"
                            value={urlInput}
                            onChange={(e) => setUrlInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                            placeholder="https://…"
                            autoFocus
                            className="flex-1 min-w-0 bg-stone-100 dark:bg-zinc-800 border border-stone-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-stone-800 dark:text-zinc-200 focus:outline-none focus:border-stone-400 dark:focus:border-zinc-500"
                          />
                          <button
                            onClick={handleUrlSubmit}
                            className="px-2 py-1.5 bg-amber-500 text-zinc-900 text-xs font-semibold rounded-lg hover:bg-amber-400 flex-shrink-0"
                          >
                            Load
                          </button>
                        </div>
                      )}
                      <p className="text-[10px] text-stone-300 dark:text-zinc-700 text-center">or drag &amp; drop / Ctrl+V</p>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowUploadPanel(true)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-stone-100/90 dark:bg-zinc-800/90 hover:bg-stone-200 dark:hover:bg-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-800 dark:hover:text-zinc-200 text-xs font-medium rounded-lg border border-stone-300 dark:border-zinc-700 transition-colors backdrop-blur-sm"
                      title="Add a real book map image"
                    >
                      <span className="text-[10px]">🗺️</span> Add map image
                    </button>
                  )}
                </div>
              </>
            )}
            <input id="map-upload" ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={handleFileInput} />
          </div>

          {/* Location groups */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <p className="text-xs font-medium text-stone-400 dark:text-zinc-600 uppercase tracking-wider">
                Locations · {groups.filter(g => g.location !== 'Unknown').length} known
              </p>
              <input
                type="search"
                placeholder="Find character…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="ml-auto w-36 text-xs px-2.5 py-1 rounded-lg border bg-transparent outline-none transition-colors border-stone-300 dark:border-zinc-700 text-stone-700 dark:text-zinc-300 placeholder-stone-400 dark:placeholder-zinc-600 focus:border-stone-400 dark:focus:border-zinc-500"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {groups.flatMap(({ location, characters: chars, description }) => {
                const filtered = search.trim()
                  ? chars.filter((c) => {
                      const q = search.toLowerCase();
                      return c.name.toLowerCase().includes(q)
                        || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q));
                    })
                  : chars;
                if (filtered.length === 0) return [];
                return [{ location, characters: filtered, description }];
              }).map(({ location, characters: chars, description }) => {
                const showTimeline = expandedLocation === location;
                const timeline = showTimeline ? buildLocationTimeline(location, snapshots, chapterTitles) : [];
                const hasHistory = location !== 'Unknown' && snapshots.length > 0;
                return (
                  <div
                    key={location}
                    className={`bg-white dark:bg-zinc-900 rounded-xl border border-stone-200 dark:border-zinc-800 overflow-hidden ${
                      location === 'Unknown' ? 'opacity-50' : ''
                    }`}
                  >
                    {/* Header */}
                    <div className="px-4 py-2.5 border-b border-stone-200 dark:border-zinc-800 bg-stone-100/40 dark:bg-zinc-800/40">
                      <div className="flex items-center gap-2">
                        {showTimeline ? (
                          <button
                            onClick={() => setExpandedLocation(null)}
                            className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors flex items-center gap-1 flex-shrink-0"
                          >
                            ← back
                          </button>
                        ) : (
                          <span className="text-xs text-stone-400 dark:text-zinc-600">{location === 'Unknown' ? '?' : '◎'}</span>
                        )}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-stone-700 dark:text-zinc-300 text-sm truncate">{location}</h3>
                          {(() => {
                            const aliases = locationAliasMap.get(location.toLowerCase()) ?? [];
                            return aliases.length > 0 ? (
                              <p className="text-[10px] text-stone-400 dark:text-zinc-600 truncate">aka {aliases.join(', ')}</p>
                            ) : null;
                          })()}
                        </div>
                        {hasHistory && !showTimeline && (
                          <button
                            onClick={() => setExpandedLocation(location)}
                            className="flex-shrink-0 text-[10px] text-stone-400 dark:text-zinc-600 hover:text-amber-500 dark:hover:text-amber-400 transition-colors border border-stone-200 dark:border-zinc-700 hover:border-amber-400/50 rounded px-1.5 py-0.5"
                            title="View location history"
                          >
                            History
                          </button>
                        )}
                        {!hasHistory && (
                          <span className="ml-auto text-xs text-stone-400 dark:text-zinc-600">{chars.length}</span>
                        )}
                      </div>
                      {description && !showTimeline && (
                        <p className="mt-1.5 text-xs text-stone-400 dark:text-zinc-500 leading-relaxed">{description}</p>
                      )}
                      {!showTimeline && (() => {
                        const rels = locationRelMap.get(location.toLowerCase()) ?? [];
                        if (rels.length === 0) return null;
                        return (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {rels.map((r) => (
                              <span key={r.location} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">
                                {r.relationship} · {r.location}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Characters view */}
                    {!showTimeline && (
                      <ul className="divide-y divide-stone-200/50 dark:divide-zinc-800/50">
                        {chars.map((c) => (
                          <li
                            key={c.name}
                            onClick={() => setSelectedCharName(c.name)}
                            className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-stone-50 dark:hover:bg-zinc-800/50 transition-colors"
                          >
                            <div className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold ${nameColor(c.name)}`}>
                              {initials(c.name)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-stone-700 dark:text-zinc-300 truncate">{c.name}</p>
                              <p className="text-xs text-stone-400 dark:text-zinc-500 line-clamp-2 leading-relaxed">
                                {c.recentEvents || c.description.split('.')[0]}
                              </p>
                            </div>
                            <span className={`flex-shrink-0 mt-1 w-2 h-2 rounded-full ${STATUS_DOT[c.status]}`} title={c.status} />
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Timeline view — replaces character list */}
                    {showTimeline && (
                      <div className="px-4 py-3">
                        {timeline.length === 0 ? (
                          <p className="text-xs text-stone-400 dark:text-zinc-600 py-2">No recorded events for this location.</p>
                        ) : (
                          <ol className="relative border-l border-stone-200 dark:border-zinc-700 ml-1 space-y-4">
                            {timeline.map((entry) => (
                              <li key={entry.index} className="pl-4 relative">
                                <span className="absolute -left-1 top-1 w-2 h-2 rounded-full bg-amber-500/70 border border-amber-500" />
                                <p className="text-[10px] font-medium text-stone-400 dark:text-zinc-500 mb-0.5">{entry.chapterTitle}</p>
                                {entry.events && (
                                  <p className="text-xs text-stone-600 dark:text-zinc-300 leading-relaxed">{entry.events}</p>
                                )}
                                {entry.characters.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    {entry.characters.map((name) => (
                                      <span key={name} className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 border border-stone-200 dark:border-zinc-700">
                                        {name}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
