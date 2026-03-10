'use client';

import { useEffect, useState } from 'react';
import type { Character, Snapshot } from '@/types';

const STATUS_CONFIG = {
  alive:     { label: 'Alive',     color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', dot: 'bg-emerald-400' },
  dead:      { label: 'Dead',      color: 'bg-red-500/10 text-red-400 border-red-500/20',             dot: 'bg-red-400' },
  unknown:   { label: 'Unknown',   color: 'bg-zinc-700/50 text-zinc-400 border-zinc-600/30',          dot: 'bg-zinc-500' },
  uncertain: { label: 'Uncertain', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',       dot: 'bg-amber-400' },
};

const IMPORTANCE_CONFIG = {
  main:      { label: 'Main',      color: 'bg-amber-500 text-zinc-900' },
  secondary: { label: 'Secondary', color: 'bg-zinc-700 text-zinc-300' },
  minor:     { label: 'Minor',     color: 'bg-zinc-800 text-zinc-500' },
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

interface TimelineEntry {
  chapterIndex: number;
  chapterTitle: string;
  recentEvents: string;
}

interface Props {
  character: Character;
  snapshots?: Snapshot[];
  chapterTitles?: string[];
  onClose: () => void;
}

export default function CharacterModal({ character, snapshots, chapterTitles, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview');
  const status = STATUS_CONFIG[character.status] ?? STATUS_CONFIG.unknown;
  const importance = IMPORTANCE_CONFIG[character.importance] ?? IMPORTANCE_CONFIG.minor;

  // Build deduplicated event timeline from snapshots
  const timeline: TimelineEntry[] = (() => {
    if (!snapshots?.length) return [];
    const entries: TimelineEntry[] = [];
    let lastEvents = '';
    const sorted = [...snapshots].sort((a, b) => a.index - b.index);
    for (const snap of sorted) {
      const ch = snap.result.characters.find(
        (c) => c.name.toLowerCase() === character.name.toLowerCase(),
      );
      if (!ch?.recentEvents || ch.recentEvents === lastEvents) continue;
      lastEvents = ch.recentEvents;
      entries.push({
        chapterIndex: snap.index,
        chapterTitle: chapterTitles?.[snap.index] ?? `Chapter ${snap.index + 1}`,
        recentEvents: ch.recentEvents,
      });
    }
    return entries.reverse(); // newest first
  })();

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-lg max-h-[85vh] overflow-y-auto bg-zinc-900 rounded-2xl border border-zinc-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 border-b border-zinc-800 pb-0">
          <div className="flex items-start gap-4">
            <div className={`flex-shrink-0 w-14 h-14 rounded-xl flex items-center justify-center text-lg font-bold ${nameColor(character.name)}`}>
              {initials(character.name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-zinc-100 leading-tight">{character.name}</h2>
                  {character.aliases?.length > 0 && (
                    <p className="text-sm text-zinc-500 mt-0.5">{character.aliases.join(' · ')}</p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  className="flex-shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors text-lg leading-none"
                >
                  ✕
                </button>
              </div>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <span className={`text-xs px-2.5 py-1 rounded-md font-semibold ${importance.color}`}>
                  {importance.label}
                </span>
                <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border font-medium ${status.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                  {status.label}
                </span>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-5">
            {([
              { key: 'overview', label: 'Overview' },
              ...(timeline.length > 0 ? [{ key: 'timeline', label: `Timeline (${timeline.length})` }] : []),
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setTab(key as 'overview' | 'timeline')}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                  tab === key
                    ? 'border-amber-500 text-amber-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-300'
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
              {character.description && (
                <section>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">About</p>
                  <p className="text-sm text-zinc-300 leading-relaxed">{character.description}</p>
                </section>
              )}

              {/* Location + Last seen */}
              <section className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-800">
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1">Current location</p>
                  <p className="text-sm text-zinc-300">{character.currentLocation || 'Unknown'}</p>
                </div>
                <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-800">
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-1">Last seen</p>
                  <p className="text-sm text-zinc-300">{character.lastSeen || '—'}</p>
                </div>
              </section>

              {/* Recent events */}
              {character.recentEvents && (
                <section>
                  <p className="text-xs font-semibold text-amber-500/80 uppercase tracking-wider mb-1.5">Recent events</p>
                  <div className="p-3 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                    <p className="text-sm text-zinc-300 leading-relaxed">{character.recentEvents}</p>
                  </div>
                </section>
              )}

              {/* Relationships */}
              {character.relationships?.length > 0 && (
                <section>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                    Relationships ({character.relationships.length})
                  </p>
                  <ul className="space-y-2">
                    {character.relationships.map((rel, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(rel.character)}`}>
                          {initials(rel.character)}
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <span className="text-sm font-medium text-zinc-200">{rel.character}</span>
                          <span className="text-sm text-zinc-500"> — {rel.relationship}</span>
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
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                Event history · newest first
              </p>
              {timeline.length === 0 ? (
                <p className="text-sm text-zinc-600 text-center py-6">No history yet — analyze more chapters to build a timeline.</p>
              ) : (
                <ol className="relative border-l border-zinc-800 space-y-0">
                  {timeline.map((entry, i) => (
                    <li key={i} className="pl-5 pb-6 last:pb-0 relative">
                      {/* dot */}
                      <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-zinc-700 border border-zinc-600" />
                      <p className="text-[11px] font-semibold text-zinc-500 mb-1">
                        Ch. {entry.chapterIndex + 1} — {entry.chapterTitle}
                      </p>
                      <p className="text-sm text-zinc-300 leading-relaxed">{entry.recentEvents}</p>
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
