'use client';

import { useState } from 'react';
import type { AnalysisResult, NarrativeArc, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import NarrativeArcModal from '@/components/NarrativeArcModal';

interface Props {
  arcs: NarrativeArc[];
  snapshots: Snapshot[];
  chapterTitles: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (result: AnalysisResult, propagate?: SnapshotTransform) => void;
  arcChapterMap?: Map<string, number[]>;
}

const STATUS_CONFIG = {
  active:   { label: 'Active',   dot: 'bg-amber-500',   badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  dormant:  { label: 'Dormant',  dot: 'bg-stone-400',   badge: 'bg-stone-100 dark:bg-zinc-800 text-stone-400 dark:text-zinc-500 border-stone-200 dark:border-zinc-700' },
  resolved: { label: 'Resolved', dot: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
};

export default function ArcsPanel({ arcs, snapshots, chapterTitles, currentResult, onResultEdit, arcChapterMap: arcChapterMapProp }: Props) {
  const [selectedArc, setSelectedArc] = useState<string | null>(null);
  if (arcs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <span className="text-5xl opacity-20">📖</span>
        <p className="text-stone-500 dark:text-zinc-400 font-medium">No narrative arcs yet</p>
        <p className="text-sm text-stone-400 dark:text-zinc-600 max-w-xs">
          Arcs are extracted as you analyze chapters. Re-analyze chapters with the latest model to populate this view.
        </p>
      </div>
    );
  }

  // Sort: active first, then dormant, then resolved
  const order = { active: 0, dormant: 1, resolved: 2 };
  const sorted = [...arcs].sort((a, b) => order[a.status] - order[b.status]);

  const arcChapterMap = arcChapterMapProp ?? (() => {
    const map = new Map<string, number[]>();
    for (const arc of arcs) {
      const indices: number[] = [];
      for (const snap of [...snapshots].sort((a, b) => a.index - b.index)) {
        const snapChars = new Set(snap.result.characters.map((c) => c.name.toLowerCase()));
        const hasOverlap = arc.characters.some((c) => snapChars.has(c.toLowerCase()));
        const inSnapArcs = (snap.result.arcs ?? []).some((a) => a.name.toLowerCase() === arc.name.toLowerCase());
        if (hasOverlap || inSnapArcs) indices.push(snap.index);
      }
      map.set(arc.name, indices);
    }
    return map;
  })();

  const totalChapters = Math.max(...snapshots.map((s) => s.index), 0) + 1;

  return (
    <>
    {selectedArc && (
      <NarrativeArcModal
        arcName={selectedArc}
        snapshots={snapshots}
        chapterTitles={chapterTitles}
        currentResult={currentResult}
        onResultEdit={onResultEdit}
        onClose={() => setSelectedArc(null)}
      />
    )}
    <div className="space-y-4">
      {sorted.map((arc) => {
        const cfg = STATUS_CONFIG[arc.status];
        const chapters = arcChapterMap.get(arc.name) ?? [];
        const firstCh = chapters[0] ?? null;
        const lastCh = chapters[chapters.length - 1] ?? null;

        return (
          <button
            key={arc.name}
            onClick={() => setSelectedArc(arc.name)}
            className="w-full text-left rounded-xl border border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3 hover:border-stone-300 dark:hover:border-zinc-700 hover:shadow-sm transition-all cursor-pointer"
          >
            {/* Header row */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${cfg.dot} ${arc.status === 'active' ? 'animate-pulse' : ''}`} />
                <h3 className="font-semibold text-stone-800 dark:text-zinc-100 text-sm leading-snug">{arc.name}</h3>
              </div>
              <span className={`flex-shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cfg.badge}`}>
                {cfg.label}
              </span>
            </div>

            {/* Summary */}
            <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">{arc.summary}</p>

            {/* Characters involved */}
            {arc.characters.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {arc.characters.map((name) => (
                  <span
                    key={name}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 border border-stone-200 dark:border-zinc-700"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}

            {/* Chapter span bar */}
            {chapters.length > 0 && totalChapters > 1 && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-stone-400 dark:text-zinc-600">
                  <span>
                    {firstCh !== null ? (chapterTitles[firstCh] ?? `Ch. ${firstCh + 1}`) : '—'}
                  </span>
                  {lastCh !== firstCh && lastCh !== null && (
                    <span>
                      {chapterTitles[lastCh] ?? `Ch. ${lastCh + 1}`}
                    </span>
                  )}
                </div>
                <div className="w-full h-1.5 bg-stone-100 dark:bg-zinc-800 rounded-full overflow-hidden relative">
                  {/* Filled span */}
                  <div
                    className={`absolute top-0 h-full rounded-full ${cfg.dot} opacity-60`}
                    style={{
                      left: `${(( firstCh ?? 0) / totalChapters) * 100}%`,
                      width: `${Math.max(2, (((lastCh ?? firstCh ?? 0) - (firstCh ?? 0) + 1) / totalChapters) * 100)}%`,
                    }}
                  />
                  {/* Chapter tick marks */}
                  {chapters.map((idx) => (
                    <div
                      key={idx}
                      className={`absolute top-0 w-0.5 h-full ${cfg.dot}`}
                      style={{ left: `${((idx + 0.5) / totalChapters) * 100}%` }}
                      title={chapterTitles[idx] ?? `Ch. ${idx + 1}`}
                    />
                  ))}
                </div>
              </div>
            )}
          </button>
        );
      })}
    </div>
    </>
  );
}
