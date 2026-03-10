'use client';

import { useRef, useState } from 'react';
import type { Character, LocationInfo, Snapshot } from '@/types';
import LocationGraph from './LocationGraph';

interface LocationGroup {
  location: string;
  characters: Character[];
  description?: string;
}

const STATUS_DOT: Record<Character['status'], string> = {
  alive: 'bg-emerald-400',
  dead: 'bg-red-400',
  unknown: 'bg-zinc-500',
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
}

export default function LocationBoard({ characters, locations, bookTitle, snapshots = [] }: Props) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [mapImage, setMapImage] = useState<string | null>(null);
  const [mapLabel, setMapLabel] = useState('');
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const locationDescMap = new Map((locations ?? []).map((l) => [l.name.toLowerCase(), l.description]));

  const groups: LocationGroup[] = [];
  const seen = new Map<string, Character[]>();
  for (const c of characters) {
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

  function loadFile(file: File) {
    setMapLabel(file.name.replace(/\.[^.]+$/, ''));
    const reader = new FileReader();
    reader.onload = (ev) => setMapImage(ev.target?.result as string);
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
        setMapImage(url);
        setMapLabel('Map');
      }
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const imageFile = Array.from(e.clipboardData.items)
      .find((item) => item.type.startsWith('image/'))
      ?.getAsFile();
    if (imageFile) { loadFile(imageFile); return; }
    const text = e.clipboardData.getData('text');
    if (text?.startsWith('http')) { setMapImage(text); setMapLabel('Map'); }
  }

  function handleUrlSubmit() {
    if (urlInput.trim()) {
      setMapImage(urlInput.trim());
      setMapLabel('Map');
      setUrlInput('');
      setShowUrlInput(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* View toggle */}
      <div className="flex gap-1 bg-zinc-800/50 rounded-lg p-0.5 w-fit border border-zinc-800">
        <button
          onClick={() => setView('list')}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            view === 'list' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          List
        </button>
        <button
          onClick={() => setView('graph')}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            view === 'graph' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Graph
        </button>
      </div>

      {view === 'graph' && (
        <LocationGraph snapshots={snapshots} />
      )}

      {view === 'list' && (
      <>
      {/* Map section */}
      <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
        {mapImage ? (
          <div>
            <div className="relative">
              <img src={mapImage} alt={mapLabel || 'Book map'} className="w-full max-h-96 object-contain bg-zinc-950" />
              <button
                onClick={() => { setMapImage(null); setMapLabel(''); }}
                className="absolute top-2 right-2 bg-zinc-900/80 hover:bg-zinc-900 text-zinc-400 hover:text-red-400 rounded-lg w-7 h-7 flex items-center justify-center text-sm transition-colors border border-zinc-700"
                title="Remove map"
              >
                ✕
              </button>
            </div>
            {mapLabel && (
              <p className="text-xs text-center text-zinc-600 py-2 border-t border-zinc-800">{mapLabel}</p>
            )}
          </div>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onPaste={handlePaste}
            tabIndex={0}
            className={`flex flex-col items-center justify-center gap-3 py-8 outline-none transition-colors ${
              dragging ? 'bg-amber-500/5' : ''
            }`}
          >
            <span className="text-3xl opacity-30">🗺️</span>
            <p className="text-sm font-medium text-zinc-500">Add your book&apos;s map</p>

            <div className="flex gap-2 flex-wrap justify-center">
              <label
                htmlFor="map-upload"
                className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs font-medium rounded-lg cursor-pointer hover:bg-zinc-700 transition-colors border border-zinc-700"
              >
                Upload file
              </label>
              {bookTitle && (
                <a
                  href={`https://www.google.com/search?q=${encodeURIComponent(bookTitle + ' map')}&tbm=isch`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs font-medium rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-700"
                >
                  Search Google Images
                </a>
              )}
              <button
                onClick={() => setShowUrlInput((v) => !v)}
                className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs font-medium rounded-lg hover:bg-zinc-700 transition-colors border border-zinc-700"
              >
                Paste URL
              </button>
            </div>

            {showUrlInput && (
              <div className="flex gap-2 w-full max-w-sm px-4">
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                  placeholder="https://…"
                  autoFocus
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
                />
                <button
                  onClick={handleUrlSubmit}
                  className="px-3 py-1.5 bg-amber-500 text-zinc-900 text-xs font-semibold rounded-lg hover:bg-amber-400"
                >
                  Load
                </button>
              </div>
            )}

            <p className="text-xs text-zinc-700">
              drag &amp; drop · or <kbd className="bg-zinc-800 px-1 py-0.5 rounded text-zinc-600 border border-zinc-700 text-[10px]">Ctrl+V</kbd> to paste
            </p>

            <input id="map-upload" ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={handleFileInput} />
          </div>
        )}
      </div>

      {/* Location groups */}
      <div>
        <p className="text-xs font-medium text-zinc-600 uppercase tracking-wider mb-3">
          Locations · {groups.filter(g => g.location !== 'Unknown').length} known
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {groups.map(({ location, characters: chars, description }) => (
            <div
              key={location}
              className={`bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden ${
                location === 'Unknown' ? 'opacity-50' : ''
              }`}
            >
              <div className="px-4 py-2.5 border-b border-zinc-800 bg-zinc-800/40">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-600">{location === 'Unknown' ? '?' : '◎'}</span>
                  <h3 className="font-medium text-zinc-300 text-sm">{location}</h3>
                  <span className="ml-auto text-xs text-zinc-600">{chars.length}</span>
                </div>
                {description && (
                  <p className="mt-1.5 text-xs text-zinc-500 leading-relaxed">{description}</p>
                )}
              </div>

              <ul className="divide-y divide-zinc-800/50">
                {chars.map((c) => (
                  <li key={c.name} className="px-4 py-3 flex items-start gap-3">
                    <div className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold ${nameColor(c.name)}`}>
                      {initials(c.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-300 truncate">{c.name}</p>
                      <p className="text-xs text-zinc-500 line-clamp-2 leading-relaxed">
                        {c.recentEvents || c.description.split('.')[0]}
                      </p>
                    </div>
                    <span className={`flex-shrink-0 mt-1 w-2 h-2 rounded-full ${STATUS_DOT[c.status]}`} title={c.status} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
