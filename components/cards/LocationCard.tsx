'use client';

import { useState } from 'react';
import type { AnalysisResult, Character, LocationInfo, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import LocationModal from '@/components/LocationModal';

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

function nameColor(name: string): string {
  const colors = [
    'bg-teal/15 text-teal',
    'bg-rust/15 text-rust',
    'bg-amber/15 text-amber',
    'bg-danger/15 text-danger',
    'bg-teal-soft/15 text-teal-soft',
    'bg-rust-soft/15 text-rust-soft',
    'bg-ink-soft/15 text-ink-soft',
  ];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return colors[Math.abs(hash) % colors.length];
}

interface Props {
  location: LocationInfo;
  characters: Character[];
  isCurrentChapter: boolean;
  snapshots?: Snapshot[];
  chapterTitles?: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (result: AnalysisResult, propagate?: SnapshotTransform) => void;
  currentChapterIndex?: number;
}

export default function LocationCard({ location, characters, isCurrentChapter, snapshots, chapterTitles, currentResult, onResultEdit, currentChapterIndex }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const residentsHere = characters.filter((c) => c.currentLocation === location.name);

  return (
    <>
      {modalOpen && (
        <LocationModal
          locationName={location.name}
          snapshots={snapshots ?? []}
          chapterTitles={chapterTitles}
          currentResult={currentResult}
          onResultEdit={onResultEdit}
          currentChapterIndex={currentChapterIndex}
          onClose={() => setModalOpen(false)}
        />
      )}
      <div
        onClick={() => setModalOpen(true)}
        className="bg-paper-raised rounded-xl border border-border overflow-hidden transition-all duration-200 cursor-pointer hover:border-teal/30"
      >
        <div className="p-3 flex items-center gap-3">
          <div className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(location.name)}`}>
            {initials(location.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-serif text-[17px] font-medium text-ink leading-tight truncate">{location.name}</h3>
              {isCurrentChapter && (
                <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase bg-teal text-white">
                  CURRENT
                </span>
              )}
            </div>
            {location.parentLocation && (
              <p className="text-xs font-mono text-ink-dim mt-0.5 truncate">{location.parentLocation}</p>
            )}
          </div>
          {residentsHere.length > 0 && (
            <span className="flex-shrink-0 text-xs font-mono text-ink-dim">
              {residentsHere.length} here
            </span>
          )}
        </div>

        <div className={`overflow-hidden transition-all duration-200 ${expanded ? 'max-h-[400px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-3 pb-2">
            <p className="text-sm font-serif text-ink-soft leading-relaxed">{location.description}</p>
          </div>
          {location.recentEvents && (
            <div className="mx-3 mb-2 p-2.5 bg-paper rounded-lg border border-border">
              <p className="text-[10px] font-mono font-bold text-amber uppercase mb-0.5">Recent</p>
              <p className="text-xs font-serif text-ink-soft leading-relaxed">{location.recentEvents}</p>
            </div>
          )}
          {residentsHere.length > 0 && (
            <div className="px-3 pb-2">
              <p className="text-[10px] font-mono font-bold text-ink-dim uppercase mb-1">Characters here</p>
              <div className="flex flex-wrap gap-1">
                {residentsHere.map((c) => (
                  <span key={c.name} className="text-xs font-serif text-ink-soft bg-paper px-2 py-0.5 rounded">
                    {c.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className="px-3 py-2 border-t border-border flex items-center justify-end"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          <svg
            width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
            className={`text-ink-dim transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="M3 4.5l3 3 3-3"/>
          </svg>
        </div>
      </div>
    </>
  );
}
