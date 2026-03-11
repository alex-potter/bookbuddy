'use client';

import { useEffect, useState } from 'react';
import type { LocationRelationship, Snapshot } from '@/types';

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

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

const STATUS_DOT: Record<string, string> = {
  alive: 'bg-emerald-400',
  dead: 'bg-red-400',
  unknown: 'bg-stone-400 dark:bg-zinc-500',
  uncertain: 'bg-amber-400',
};

interface TimelineEntry {
  chapterIndex: number;
  locationEvents?: string;  // from LocationInfo.recentEvents for this snapshot
  characters: { name: string; status: string }[];
}

interface Props {
  locationName: string;
  snapshots: Snapshot[];
  chapterTitles?: string[];
  onClose: () => void;
}

export default function LocationModal({ locationName, snapshots, chapterTitles, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview');

  // Find the most recent LocationInfo for description + arc + relationships
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  let description = '';
  let arc = '';
  let relationships: LocationRelationship[] = [];
  for (const snap of sorted) {
    const info = snap.result.locations?.find(
      (l) => l.name?.toLowerCase().trim() === locationName.toLowerCase().trim(),
    );
    if (info?.description) description = info.description;
    if (info?.arc) arc = info.arc;
    if (info?.relationships?.length) relationships = info.relationships;
  }

  // Characters currently here (from latest snapshot)
  const latestSnap = sorted[sorted.length - 1];
  const currentChars = latestSnap?.result.characters.filter(
    (c) => c.currentLocation?.trim().toLowerCase() === locationName.toLowerCase().trim(),
  ) ?? [];

  // Build timeline: chapters where something happened at this location
  const timeline: TimelineEntry[] = [];
  let prevCharNames = new Set<string>();
  for (const snap of sorted) {
    const locInfo = snap.result.locations?.find(
      (l) => l.name?.toLowerCase().trim() === locationName.toLowerCase().trim(),
    );
    const present = snap.result.characters.filter(
      (c) => c.currentLocation?.trim().toLowerCase() === locationName.toLowerCase().trim(),
    );

    const curNames = new Set(present.map((c) => c.name));
    const charsChanged = present.length !== prevCharNames.size || [...curNames].some((n) => !prevCharNames.has(n));
    const hasEvents = !!locInfo?.recentEvents;

    if (present.length > 0 && (charsChanged || hasEvents)) {
      timeline.push({
        chapterIndex: snap.index,
        locationEvents: locInfo?.recentEvents,
        characters: present.map((c) => ({ name: c.name, status: c.status })),
      });
    }
    prevCharNames = present.length > 0 ? curNames : new Set();
  }
  const timelineReversed = [...timeline].reverse();

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="relative z-10 w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl border border-stone-200 dark:border-zinc-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 border-b border-stone-200 dark:border-zinc-800 pb-0">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-stone-100 dark:bg-zinc-800 flex items-center justify-center text-2xl">
              📍
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-bold text-stone-900 dark:text-zinc-100 leading-tight">{locationName}</h2>
                  {arc && (
                    <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                      {arc}
                    </span>
                  )}
                </div>
                <button
                  onClick={onClose}
                  className="flex-shrink-0 text-stone-400 dark:text-zinc-600 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
                >
                  ✕
                </button>
              </div>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                {currentChars.length > 0 && (
                  <span className="text-xs px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                    {currentChars.length} character{currentChars.length !== 1 ? 's' : ''} here
                  </span>
                )}
                {currentChars.length === 0 && (
                  <span className="text-xs text-stone-400 dark:text-zinc-500">No characters currently here</span>
                )}
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-5">
            {([
              { key: 'overview', label: 'Overview' },
              ...(timelineReversed.length > 0 ? [{ key: 'timeline', label: `Timeline (${timelineReversed.length})` }] : []),
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setTab(key as 'overview' | 'timeline')}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                  tab === key
                    ? 'border-amber-500 text-amber-400'
                    : 'border-transparent text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-5">
          {tab === 'overview' ? (
            <>
              {/* Description */}
              {description ? (
                <section>
                  <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">About</p>
                  <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{description}</p>
                </section>
              ) : (
                <p className="text-sm text-stone-400 dark:text-zinc-600 italic">No description available — analyze more chapters to populate.</p>
              )}

              {/* Characters currently here */}
              {currentChars.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Currently here</p>
                  <ul className="space-y-2">
                    {currentChars.map((c) => (
                      <li key={c.name} className="flex items-start gap-3">
                        <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(c.name)}`}>
                          {initials(c.name)}
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{c.name}</span>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[c.status] ?? STATUS_DOT.unknown}`} />
                          </div>
                          {c.recentEvents && (
                            <p className="text-xs text-stone-400 dark:text-zinc-500 mt-0.5 line-clamp-2">{c.recentEvents}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Related places */}
              {relationships.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Related Places</p>
                  <ul className="space-y-1.5">
                    {relationships.map((r) => (
                      <li key={r.location} className="flex items-center gap-2 text-sm">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 flex-shrink-0">{r.relationship}</span>
                        <span className="text-stone-700 dark:text-zinc-300">{r.location}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            /* Timeline tab */
            <section>
              <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-4">
                Visitor history · newest first
              </p>
              {timelineReversed.length === 0 ? (
                <p className="text-sm text-stone-400 dark:text-zinc-600 text-center py-6">No history yet.</p>
              ) : (
                <ol className="relative border-l border-stone-200 dark:border-zinc-800 space-y-0">
                  {timelineReversed.map((entry, i) => (
                    <li key={i} className="pl-5 pb-6 last:pb-0 relative">
                      <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-stone-200 dark:bg-zinc-700 border border-stone-300 dark:border-zinc-600" />
                      <p className="text-[11px] font-semibold text-stone-400 dark:text-zinc-500 mb-2">
                        Ch. {entry.chapterIndex + 1}{chapterTitles?.[entry.chapterIndex] ? ` — ${chapterTitles[entry.chapterIndex]}` : ''}
                      </p>
                      {entry.locationEvents && (
                        <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed mb-2">{entry.locationEvents}</p>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {entry.characters.map((c) => (
                          <span key={c.name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-medium ${nameColor(c.name)}`}>
                            <span className={`w-1 h-1 rounded-full flex-shrink-0 ${STATUS_DOT[c.status] ?? STATUS_DOT.unknown}`} />
                            {c.name}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
