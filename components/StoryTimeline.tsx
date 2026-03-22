'use client';

import { useEffect, useRef, useState } from 'react';
import type { AnalysisResult, PinUpdates, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import CharacterModal from './CharacterModal';
import NarrativeArcModal from './NarrativeArcModal';
import LocationModal from './LocationModal';

interface StoryTimelineProps {
  snapshots: Snapshot[];
  chapterTitles: string[];
  currentIndex: number;
  currentResult?: AnalysisResult;
  onResultEdit?: (result: AnalysisResult, propagate?: SnapshotTransform, pinUpdates?: PinUpdates) => void;
  onClose: () => void;
  onJumpToChapter: (index: number) => void;
}

export default function StoryTimeline({ snapshots, chapterTitles, currentIndex, currentResult, onResultEdit, onClose, onJumpToChapter }: StoryTimelineProps) {
  const currentRef = useRef<HTMLDivElement>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [selectedArc, setSelectedArc] = useState<string | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);

  // Filter to snapshots that have a summary
  const entries = snapshots
    .filter((s) => s.result.summary)
    .sort((a, b) => a.index - b.index);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Scroll current chapter into view on mount
  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 rounded-2xl border border-stone-200 dark:border-zinc-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-6 pb-4 border-b border-stone-200 dark:border-zinc-800 flex-shrink-0">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-800 flex items-center justify-center text-lg">
            📖
          </div>
          <h2 className="text-lg font-bold text-stone-900 dark:text-zinc-100 flex-1">Story Timeline</h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {entries.length === 0 ? (
            <p className="text-sm text-stone-400 dark:text-zinc-500 text-center py-8">No chapter summaries yet</p>
          ) : (
            <div className="relative">
              {/* Vertical connector line */}
              <div className="absolute left-[9px] top-3 bottom-3 w-px bg-stone-200 dark:bg-zinc-700" />

              <div className="space-y-5">
                {entries.map((snap, entryIdx) => {
                  const isCurrent = snap.index === currentIndex;
                  return (
                    <div
                      key={snap.index}
                      ref={isCurrent ? currentRef : undefined}
                      className={`relative pl-8 cursor-pointer group transition-colors rounded-lg p-3 -ml-3 ${
                        isCurrent
                          ? 'bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-300 dark:ring-amber-700'
                          : 'hover:bg-stone-50 dark:hover:bg-zinc-800/50'
                      }`}
                      onClick={() => onJumpToChapter(snap.index)}
                    >
                      {/* Dot marker */}
                      <div
                        className={`absolute left-[5px] top-[18px] w-[10px] h-[10px] rounded-full border-2 ${
                          isCurrent
                            ? 'bg-amber-400 border-amber-500 dark:bg-amber-500 dark:border-amber-400'
                            : 'bg-white dark:bg-zinc-900 border-stone-300 dark:border-zinc-600 group-hover:border-stone-400 dark:group-hover:border-zinc-500'
                        }`}
                      />

                      {/* Chapter label */}
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-medium text-stone-400 dark:text-zinc-500 bg-stone-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                          Ch {snap.index + 1}
                        </span>
                        <span className="text-sm font-semibold text-stone-800 dark:text-zinc-200 truncate">
                          {chapterTitles[snap.index] ?? `Chapter ${snap.index + 1}`}
                        </span>
                      </div>

                      {/* Summary */}
                      <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">
                        {snap.result.summary}
                      </p>

                      {/* Entity tags — chapter-relevant only */}
                      {(() => {
                        const prevResult = entries[entryIdx - 1]?.result;

                        // Characters: main chars whose lastSeen or recentEvents changed from previous snapshot
                        const prevCharMap = new Map(prevResult?.characters.map((c) => [c.name, c]) ?? []);
                        const mainChars = snap.result.characters
                          .filter((c) => {
                            if (c.importance !== 'main') return false;
                            const prev = prevCharMap.get(c.name);
                            return !prev || prev.lastSeen !== c.lastSeen || prev.recentEvents !== c.recentEvents;
                          })
                          .slice(0, 3);

                        // Arcs: active arcs involving a chapter-active character
                        const chapterCharNames = new Set(mainChars.map((c) => c.name));
                        const activeArcs = (snap.result.arcs ?? [])
                          .filter((a) => a.status === 'active' && a.characters.some((n) => chapterCharNames.has(n)))
                          .slice(0, 2);

                        // Locations: those whose recentEvents changed from previous snapshot
                        const prevLocMap = new Map((prevResult?.locations ?? []).map((l) => [l.name, l]) ?? []);
                        const locs = (snap.result.locations ?? [])
                          .filter((l) => {
                            if (!l.recentEvents) return false;
                            const prev = prevLocMap.get(l.name);
                            return !prev || prev.recentEvents !== l.recentEvents;
                          })
                          .slice(0, 2);
                        if (mainChars.length === 0 && activeArcs.length === 0 && locs.length === 0) return null;
                        return (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {mainChars.map((c) => (
                              <button
                                key={`char-${c.name}`}
                                onClick={(e) => { e.stopPropagation(); setSelectedCharacter(c.name); }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors"
                              >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                                </svg>
                                {c.name}
                              </button>
                            ))}
                            {activeArcs.map((a) => (
                              <button
                                key={`arc-${a.name}`}
                                onClick={(e) => { e.stopPropagation(); setSelectedArc(a.name); }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                              >
                                {a.name}
                              </button>
                            ))}
                            {locs.map((l) => (
                              <button
                                key={`loc-${l.name}`}
                                onClick={(e) => { e.stopPropagation(); setSelectedLocation(l.name); }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors"
                              >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                </svg>
                                {l.name}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sub-modals for entity details */}
      {selectedCharacter && currentResult && (() => {
        const character = currentResult.characters.find((c) => c.name === selectedCharacter);
        return character ? (
          <CharacterModal
            character={character}
            snapshots={snapshots}
            chapterTitles={chapterTitles}
            currentResult={currentResult}
            onResultEdit={onResultEdit}
            onClose={() => setSelectedCharacter(null)}
          />
        ) : null;
      })()}
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
      {selectedLocation && (
        <LocationModal
          locationName={selectedLocation}
          snapshots={snapshots}
          chapterTitles={chapterTitles}
          currentResult={currentResult}
          onResultEdit={onResultEdit}
          onClose={() => setSelectedLocation(null)}
        />
      )}
    </div>
  );
}
