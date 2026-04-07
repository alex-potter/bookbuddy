'use client';

import { useEffect, useRef, useState } from 'react';
import type { AnalysisResult, ChapterEvent, PinUpdates, ReadingPosition, Snapshot } from '@/types';
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
  readingPosition?: ReadingPosition;
  onSetReadingPosition?: (position: ReadingPosition) => void;
  onClose: () => void;
  onJumpToChapter: (index: number) => void;
}

export default function StoryTimeline({ snapshots, chapterTitles, currentIndex, currentResult, onResultEdit, readingPosition, onSetReadingPosition, onClose, onJumpToChapter }: StoryTimelineProps) {
  const currentRef = useRef<HTMLDivElement>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [selectedArc, setSelectedArc] = useState<string | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);

  // Filter to snapshots that have a summary
  const entries = snapshots
    .filter((s) => s.result.summary && s.index <= currentIndex)
    .sort((a, b) => a.index - b.index);

  const visibleEntries = readingPosition
    ? entries.filter((s) => s.index <= readingPosition.chapterIndex)
    : entries;

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleEntityClick = (type: 'character' | 'location' | 'arc', name: string) => {
    setSelectedCharacter(type === 'character' ? name : null);
    setSelectedLocation(type === 'location' ? name : null);
    setSelectedArc(type === 'arc' ? name : null);
  };

  // Scroll current chapter into view on mount
  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  function buildLegacyEvent(snap: Snapshot, prevResult?: AnalysisResult): { summary: string; characters: string[]; locations: string[]; arcNames: string[] } {
    const prevCharMap = new Map(prevResult?.characters.map((c) => [c.name, c]) ?? []);
    const characters = snap.result.characters
      .filter((c) => {
        if (c.importance !== 'main') return false;
        const prev = prevCharMap.get(c.name);
        return !prev || prev.lastSeen !== c.lastSeen || prev.recentEvents !== c.recentEvents;
      })
      .slice(0, 3)
      .map((c) => c.name);

    const prevLocMap = new Map((prevResult?.locations ?? []).map((l) => [l.name, l]) ?? []);
    const locations = (snap.result.locations ?? [])
      .filter((l) => {
        if (!l.recentEvents) return false;
        const prev = prevLocMap.get(l.name);
        return !prev || prev.recentEvents !== l.recentEvents;
      })
      .slice(0, 2)
      .map((l) => l.name);

    const chapterCharNames = new Set(characters);
    const arcNames = (snap.result.arcs ?? [])
      .filter((a) => a.status === 'active' && a.characters.some((n) => chapterCharNames.has(n)))
      .slice(0, 2)
      .map((a) => a.name);

    return { summary: snap.result.summary, characters, locations, arcNames };
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="relative z-10 w-full max-w-2xl max-h-[85vh] max-h-[85dvh] flex flex-col bg-white dark:bg-zinc-900 rounded-2xl border border-stone-200 dark:border-zinc-800 shadow-2xl"
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
          {visibleEntries.length === 0 ? (
            <p className="text-sm text-stone-400 dark:text-zinc-500 text-center py-8">No chapter summaries yet</p>
          ) : (
            <div className="relative">
              {/* Vertical connector line */}
              <div className="absolute left-[9px] top-3 bottom-3 w-px bg-stone-200 dark:bg-zinc-700" />

              <div className="space-y-5">
                {visibleEntries.map((snap, entryIdx) => {
                  const isCurrent = snap.index === currentIndex;
                  const prevResult = visibleEntries[entryIdx - 1]?.result;
                  const events: Array<{ summary: string; characters: string[]; locations: string[]; arcNames: string[] }> =
                    snap.events?.length
                      ? snap.events.map((ev) => ({
                          summary: ev.summary,
                          characters: ev.characters,
                          locations: ev.locations,
                          arcNames: (ev.arcSnapshots ?? []).filter((a) => a.status === 'active').map((a) => a.name),
                        }))
                      : [buildLegacyEvent(snap, prevResult)];

                  // Filter events by reading position within the current chapter
                  const visibleEvents = (readingPosition && snap.index === readingPosition.chapterIndex && readingPosition.progress != null
                    ? events.map((ev, i) => ({ ...ev, _origIdx: i })).filter(({ _origIdx }) => {
                        const evProgress = snap.events?.[_origIdx]?.chapterProgress ?? 0.5;
                        return evProgress <= readingPosition.progress!;
                      })
                    : events.map((ev, i) => ({ ...ev, _origIdx: i }))
                  );
                  if (visibleEvents.length === 0) return null;

                  return (
                    <div key={snap.index} ref={isCurrent ? currentRef : undefined}>
                      {/* Chapter header */}
                      <div className="relative pl-8 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-medium text-stone-400 dark:text-zinc-500 bg-stone-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                            Ch {snap.index + 1}
                          </span>
                          <span className="text-sm font-semibold text-stone-800 dark:text-zinc-200 truncate">
                            {chapterTitles[snap.index] ?? `Chapter ${snap.index + 1}`}
                          </span>
                        </div>
                      </div>

                      {/* Event cards */}
                      {visibleEvents.map((ev, evIdx) => {
                        const isLastVisible = snap.index === visibleEntries[visibleEntries.length - 1]?.index && evIdx === visibleEvents.length - 1;
                        return (
                          <div
                            key={evIdx}
                            className={`relative pl-8 cursor-pointer group transition-colors rounded-lg p-3 -ml-3 ${
                              isLastVisible
                                ? 'bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-300 dark:ring-amber-700'
                                : 'hover:bg-stone-50 dark:hover:bg-zinc-800/50'
                            }`}
                            onClick={() => onJumpToChapter(snap.index)}
                          >
                            {/* Dot marker */}
                            <div
                              className={`absolute left-[5px] top-[18px] w-[10px] h-[10px] rounded-full border-2 ${
                                isLastVisible
                                  ? 'bg-amber-400 border-amber-500 dark:bg-amber-500 dark:border-amber-400'
                                  : 'bg-white dark:bg-zinc-900 border-stone-300 dark:border-zinc-600 group-hover:border-stone-400 dark:group-hover:border-zinc-500'
                              }`}
                            />

                            {/* Summary */}
                            <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">
                              {ev.summary}
                            </p>

                            {/* Entity tags */}
                            {(ev.characters.length > 0 || ev.locations.length > 0 || ev.arcNames.length > 0) && (
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {ev.characters.slice(0, 3).map((name) => (
                                  <button
                                    key={`char-${name}`}
                                    onClick={(e) => { e.stopPropagation(); setSelectedCharacter(name); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors"
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                                    </svg>
                                    {name}
                                  </button>
                                ))}
                                {ev.arcNames.slice(0, 2).map((name) => (
                                  <button
                                    key={`arc-${name}`}
                                    onClick={(e) => { e.stopPropagation(); setSelectedArc(name); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                                  >
                                    {name}
                                  </button>
                                ))}
                                {ev.locations.slice(0, 2).map((name) => (
                                  <button
                                    key={`loc-${name}`}
                                    onClick={(e) => { e.stopPropagation(); setSelectedLocation(name); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors"
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                    </svg>
                                    {name}
                                  </button>
                                ))}
                              </div>
                            )}
                            {onSetReadingPosition && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const progress = snap.events?.[ev._origIdx]?.chapterProgress;
                                  onSetReadingPosition({ chapterIndex: snap.index, progress });
                                }}
                                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-stone-400 dark:text-zinc-500 hover:text-stone-600 dark:hover:text-zinc-300"
                                title="Set reading position here"
                              >
                                <svg width="12" height="16" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                                  <path d="M1 1h8v12l-4-3-4 3V1z" />
                                </svg>
                              </button>
                            )}
                          </div>
                        );
                      })}
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
        const lower = selectedCharacter.toLowerCase();
        const character = currentResult.characters.find((c) => c.name === selectedCharacter)
          ?? currentResult.characters.find((c) => c.name.toLowerCase() === lower)
          ?? currentResult.characters.find((c) =>
               c.aliases.some((a) => a.toLowerCase() === lower));
        return character ? (
          <CharacterModal
            character={character}
            snapshots={snapshots}
            chapterTitles={chapterTitles}
            currentResult={currentResult}
            onResultEdit={onResultEdit}
            currentChapterIndex={currentIndex}
            onClose={() => setSelectedCharacter(null)}
            onEntityClick={handleEntityClick}
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
          currentChapterIndex={currentIndex}
          onClose={() => setSelectedArc(null)}
          onEntityClick={handleEntityClick}
        />
      )}
      {selectedLocation && (
        <LocationModal
          locationName={selectedLocation}
          snapshots={snapshots}
          chapterTitles={chapterTitles}
          currentResult={currentResult}
          onResultEdit={onResultEdit}
          currentChapterIndex={currentIndex}
          onClose={() => setSelectedLocation(null)}
          onEntityClick={handleEntityClick}
        />
      )}
    </div>
  );
}
