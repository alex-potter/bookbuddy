'use client';

import { useState } from 'react';
import type { AnalysisResult, Character, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import CharacterModal from '@/components/CharacterModal';
import LocationModal from '@/components/LocationModal';
import StatusBadge from '@/components/ui/StatusBadge';

const IMPORTANCE_CONFIG = {
  main:      { label: 'MAJOR',     color: 'bg-rust text-white' },
  secondary: { label: 'MINOR',     color: 'bg-paper-dark text-ink-soft' },
  minor:     { label: 'MENTIONED', color: 'bg-paper-dark text-ink-dim' },
};

function nameColor(name: string): string {
  const colors = [
    'bg-rust/15 text-rust',
    'bg-teal/15 text-teal',
    'bg-amber/15 text-amber',
    'bg-danger/15 text-danger',
    'bg-rust-soft/15 text-rust-soft',
    'bg-teal-soft/15 text-teal-soft',
    'bg-amber-soft/15 text-amber-soft',
    'bg-ink-soft/15 text-ink-soft',
  ];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return colors[Math.abs(hash) % colors.length];
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

interface Props {
  character: Character;
  snapshots?: Snapshot[];
  chapterTitles?: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (result: AnalysisResult, propagate?: SnapshotTransform) => void;
  currentChapterIndex?: number;
  onChapterJump?: (index: number) => void;
}

export default function CharacterCard({ character, snapshots, chapterTitles, currentResult, onResultEdit, currentChapterIndex, onChapterJump }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [navEntity, setNavEntity] = useState<{ type: 'character' | 'location'; name: string } | null>(null);

  const handleEntityClick = (type: 'character' | 'location' | 'arc', name: string) => {
    if (type === 'character' || type === 'location') {
      setModalOpen(false);
      setNavEntity({ type, name });
    }
  };

  const importance = IMPORTANCE_CONFIG[character.importance] ?? IMPORTANCE_CONFIG.minor;

  return (
    <>
      {modalOpen && <CharacterModal character={character} snapshots={snapshots} chapterTitles={chapterTitles} currentResult={currentResult} onResultEdit={onResultEdit} currentChapterIndex={currentChapterIndex} onClose={() => setModalOpen(false)} onEntityClick={handleEntityClick} onChapterJump={onChapterJump} />}
      {navEntity?.type === 'character' && (() => {
        const navChar = currentResult?.characters.find((c) => c.name === navEntity.name);
        return navChar ? (
          <CharacterModal character={navChar} snapshots={snapshots} chapterTitles={chapterTitles} currentResult={currentResult} onResultEdit={onResultEdit} currentChapterIndex={currentChapterIndex} onClose={() => setNavEntity(null)} onEntityClick={handleEntityClick} onChapterJump={onChapterJump} />
        ) : null;
      })()}
      {navEntity?.type === 'location' && (
        <LocationModal locationName={navEntity.name} snapshots={snapshots ?? []} chapterTitles={chapterTitles} currentResult={currentResult} onResultEdit={onResultEdit} currentChapterIndex={currentChapterIndex} onClose={() => setNavEntity(null)} onEntityClick={handleEntityClick} />
      )}
      <div
        onClick={() => setModalOpen(true)}
        className="bg-paper-raised rounded-xl border border-border overflow-hidden transition-all duration-200 cursor-pointer hover:border-rust/30"
      >
        <div className="p-3 flex items-center gap-3">
          <div className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(character.name)}`}>
            {initials(character.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-serif text-[17px] font-medium text-ink leading-tight truncate">{character.name}</h3>
              <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase ${importance.color}`}>
                {importance.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge status={character.status} />
              {character.currentLocation && character.currentLocation !== 'Unknown' && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleEntityClick('location', character.currentLocation); }}
                  className="text-xs font-mono text-ink-dim truncate hover:text-teal hover:underline transition-colors"
                >
                  {character.currentLocation}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={`overflow-hidden transition-all duration-200 ${expanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-3 pb-2">
            <p className="text-sm font-serif text-ink-soft leading-relaxed">{character.description}</p>
          </div>
          {character.recentEvents && (
            <div className="mx-3 mb-2 p-2.5 bg-paper rounded-lg border border-border">
              <p className="text-[10px] font-mono font-bold text-amber uppercase mb-0.5">Recent</p>
              <p className="text-xs font-serif text-ink-soft leading-relaxed">{character.recentEvents}</p>
            </div>
          )}
          {(character.relationships?.length ?? 0) > 0 && (
            <div className="px-3 pb-2">
              <p className="text-[10px] font-mono font-bold text-ink-dim uppercase mb-1">Relationships</p>
              <ul className="space-y-1">
                {character.relationships.map((rel, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); handleEntityClick('character', rel.character); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleEntityClick('character', rel.character); } }}
                      className="font-serif font-medium text-ink hover:underline cursor-pointer"
                    >{rel.character}</span>
                    <span className="font-serif text-ink-dim">— {rel.relationship}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div
          className="px-3 py-2 border-t border-border flex items-center justify-between"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          <p className="text-xs font-mono text-ink-dim">
            Last seen:{' '}
            {(() => {
              const idx = chapterTitles?.findIndex((t) => t === character.lastSeen);
              return idx != null && idx >= 0 && onChapterJump ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onChapterJump(idx); }}
                  className="text-ink-dim hover:text-teal hover:underline transition-colors"
                >
                  {character.lastSeen}
                </button>
              ) : (
                <span>{character.lastSeen}</span>
              );
            })()}
          </p>
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
