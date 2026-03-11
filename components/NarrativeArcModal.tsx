'use client';

import { useEffect, useState } from 'react';
import type { Snapshot } from '@/types';

const STATUS_BADGE: Record<string, string> = {
  active:   'bg-amber-500/15 text-amber-400 border-amber-500/25',
  resolved: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  dormant:  'bg-stone-400/15 text-stone-400 border-stone-400/25 dark:bg-zinc-600/15 dark:text-zinc-400',
};

const CHAR_STATUS_DOT: Record<string, string> = {
  alive:     'bg-emerald-400',
  dead:      'bg-red-400',
  unknown:   'bg-stone-400 dark:bg-zinc-500',
  uncertain: 'bg-amber-400',
};

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

interface Props {
  arcName: string;
  snapshots: Snapshot[];
  chapterTitles?: string[];
  onClose: () => void;
}

export default function NarrativeArcModal({ arcName, snapshots, chapterTitles, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview');

  const sorted = [...snapshots].sort((a, b) => a.index - b.index);

  // Collect arc data across all snapshots — use latest non-empty values
  let summary = '';
  let status: string = 'active';
  let characters: string[] = [];
  for (const snap of sorted) {
    const arc = snap.result.arcs?.find((a) => a.name?.toLowerCase().trim() === arcName.toLowerCase().trim());
    if (arc?.summary) summary = arc.summary;
    if (arc?.status) status = arc.status;
    if (arc?.characters?.length) characters = arc.characters;
  }

  // Locations belonging to this arc (latest description wins)
  const locationMap = new Map<string, string>();
  for (const snap of sorted) {
    for (const loc of snap.result.locations ?? []) {
      if (loc.arc?.toLowerCase().trim() === arcName.toLowerCase().trim() && loc.name) {
        locationMap.set(loc.name, loc.description ?? locationMap.get(loc.name) ?? '');
      }
    }
  }
  const arcLocations = [...locationMap.entries()];

  // Character status from latest snapshot
  const charStatusMap = new Map<string, string>();
  for (const snap of sorted) {
    for (const c of snap.result.characters) {
      if (characters.includes(c.name)) charStatusMap.set(c.name, c.status);
    }
  }

  // Timeline: snapshots where this arc had meaningful content
  interface TimelineEntry {
    chapterIndex: number;
    summary: string;
    status: string;
    charCount: number;
  }
  const timeline: TimelineEntry[] = [];
  for (const snap of sorted) {
    const arc = snap.result.arcs?.find((a) => a.name?.toLowerCase().trim() === arcName.toLowerCase().trim());
    if (arc?.summary) {
      timeline.push({
        chapterIndex: snap.index,
        summary: arc.summary,
        status: arc.status ?? 'active',
        charCount: arc.characters?.length ?? 0,
      });
    }
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
              🎭
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-bold text-stone-900 dark:text-zinc-100 leading-tight">{arcName}</h2>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md border font-medium ${STATUS_BADGE[status] ?? STATUS_BADGE.active}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${status === 'active' ? 'bg-amber-400' : status === 'resolved' ? 'bg-emerald-400' : 'bg-stone-400'}`} />
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </span>
                    {characters.length > 0 && (
                      <span className="text-xs text-stone-400 dark:text-zinc-500">
                        {characters.length} character{characters.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {arcLocations.length > 0 && (
                      <span className="text-xs text-stone-400 dark:text-zinc-500">
                        {arcLocations.length} location{arcLocations.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="flex-shrink-0 text-stone-400 dark:text-zinc-600 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
                >
                  ✕
                </button>
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
              {/* Summary */}
              {summary ? (
                <section>
                  <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">Current State</p>
                  <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{summary}</p>
                </section>
              ) : (
                <p className="text-sm text-stone-400 dark:text-zinc-600 italic">No summary yet — analyze more chapters to populate.</p>
              )}

              {/* Characters */}
              {characters.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Characters</p>
                  <ul className="space-y-1.5">
                    {characters.map((name) => {
                      const charStatus = charStatusMap.get(name) ?? 'unknown';
                      return (
                        <li key={name} className="flex items-center gap-2.5">
                          <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(name)}`}>
                            {initials(name)}
                          </div>
                          <span className="text-sm text-stone-800 dark:text-zinc-200">{name}</span>
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ml-auto ${CHAR_STATUS_DOT[charStatus] ?? CHAR_STATUS_DOT.unknown}`} title={charStatus} />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Locations */}
              {arcLocations.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Locations</p>
                  <ul className="space-y-2">
                    {arcLocations.map(([name, desc]) => (
                      <li key={name} className="flex items-start gap-2">
                        <span className="text-stone-400 dark:text-zinc-600 mt-0.5 flex-shrink-0">📍</span>
                        <div>
                          <p className="text-sm font-medium text-stone-800 dark:text-zinc-200">{name}</p>
                          {desc && <p className="text-xs text-stone-400 dark:text-zinc-500 mt-0.5 leading-relaxed">{desc}</p>}
                        </div>
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
                Arc progression · newest first
              </p>
              <ol className="relative border-l border-stone-200 dark:border-zinc-800 space-y-0">
                {timelineReversed.map((entry, i) => (
                  <li key={i} className="pl-5 pb-6 last:pb-0 relative">
                    <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-stone-200 dark:bg-zinc-700 border border-stone-300 dark:border-zinc-600" />
                    <div className="flex items-center gap-2 mb-1.5">
                      <p className="text-[11px] font-semibold text-stone-400 dark:text-zinc-500">
                        Ch. {entry.chapterIndex + 1}{chapterTitles?.[entry.chapterIndex] ? ` — ${chapterTitles[entry.chapterIndex]}` : ''}
                      </p>
                      <span className={`text-[10px] px-1.5 py-px rounded border font-medium ${STATUS_BADGE[entry.status] ?? STATUS_BADGE.active}`}>
                        {entry.status}
                      </span>
                    </div>
                    <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{entry.summary}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
