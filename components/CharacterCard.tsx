'use client';

import { useState } from 'react';
import type { AnalysisResult, Character, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import CharacterModal from './CharacterModal';

const STATUS_CONFIG = {
  alive:     { label: 'Alive',     color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', dot: 'bg-emerald-400' },
  dead:      { label: 'Dead',      color: 'bg-red-500/10 text-red-400 border-red-500/20',             dot: 'bg-red-400' },
  unknown:   { label: 'Unknown',   color: 'bg-stone-200/50 dark:bg-zinc-700/50 text-stone-500 dark:text-zinc-400 border-stone-400 dark:border-zinc-600/30',          dot: 'bg-stone-400 dark:bg-zinc-500' },
  uncertain: { label: 'Uncertain', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',       dot: 'bg-amber-400' },
};

const IMPORTANCE_CONFIG = {
  main:      { label: 'Main',      color: 'bg-amber-500 text-zinc-900' },
  secondary: { label: 'Secondary', color: 'bg-stone-200 dark:bg-zinc-700 text-stone-700 dark:text-zinc-300' },
  minor:     { label: 'Minor',     color: 'bg-stone-100 dark:bg-zinc-800 text-stone-400 dark:text-zinc-500' },
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
  character: Character;
  snapshots?: Snapshot[];
  chapterTitles?: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (result: AnalysisResult, propagate?: SnapshotTransform) => void;
}

export default function CharacterCard({ character, snapshots, chapterTitles, currentResult, onResultEdit }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const status = STATUS_CONFIG[character.status] ?? STATUS_CONFIG.unknown;
  const importance = IMPORTANCE_CONFIG[character.importance] ?? IMPORTANCE_CONFIG.minor;

  return (
    <>
      {modalOpen && <CharacterModal character={character} snapshots={snapshots} chapterTitles={chapterTitles} currentResult={currentResult} onResultEdit={onResultEdit} onClose={() => setModalOpen(false)} />}
    <div
      onClick={() => setModalOpen(true)}
      className={`
        bg-white dark:bg-zinc-900 rounded-xl border overflow-hidden transition-colors duration-150 cursor-pointer
        ${character.importance === 'main' ? 'border-amber-500/30 hover:border-amber-500/50' : 'border-stone-200 dark:border-zinc-800 hover:border-stone-300 dark:hover:border-zinc-700'}
      `}
    >
      {/* Header */}
      <div className="p-4 flex items-start gap-3">
        <div className={`flex-shrink-0 w-11 h-11 rounded-lg flex items-center justify-center text-sm font-bold ${nameColor(character.name)}`}>
          {initials(character.name)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-stone-900 dark:text-zinc-100 leading-tight">{character.name}</h3>
              {(character.aliases?.length ?? 0) > 0 && (
                <p className="text-xs text-stone-400 dark:text-zinc-500 truncate mt-0.5">
                  {character.aliases.join(', ')}
                </p>
              )}
            </div>
            <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-md font-medium ${importance.color}`}>
              {importance.label}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md border font-medium ${status.color}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </span>
            {character.currentLocation && character.currentLocation !== 'Unknown' && (
              <span className="text-xs text-stone-400 dark:text-zinc-500 truncate">
                {character.currentLocation}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="px-4 pb-3">
        <p className="text-sm text-stone-500 dark:text-zinc-400 leading-relaxed">{character.description}</p>
      </div>

      {/* Recent events */}
      {character.recentEvents && (
        <div className="mx-4 mb-3 p-3 bg-stone-100/60 dark:bg-zinc-800/60 rounded-lg border border-stone-300/50 dark:border-zinc-700/50">
          <p className="text-xs font-medium text-amber-500 mb-1">Recent events</p>
          <p className="text-xs text-stone-500 dark:text-zinc-400 leading-relaxed">{character.recentEvents}</p>
        </div>
      )}

      {/* Relationships */}
      {(character.relationships?.length ?? 0) > 0 && (
        <div className="px-4 pb-4">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="text-xs text-stone-400 dark:text-zinc-500 hover:text-stone-700 dark:hover:text-zinc-300 flex items-center gap-1 transition-colors"
          >
            <span>{expanded ? '▾' : '▸'}</span>
            Relationships ({character.relationships.length})
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1.5">
              {character.relationships.map((rel, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="flex-shrink-0 w-5 h-5 bg-stone-100 dark:bg-zinc-800 rounded-md flex items-center justify-center text-stone-500 dark:text-zinc-400 font-medium">
                    {initials(rel.character)}
                  </span>
                  <div>
                    <span className="font-medium text-stone-700 dark:text-zinc-300">{rel.character}</span>
                    <span className="text-stone-400 dark:text-zinc-500 ml-1">— {rel.relationship}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-2 bg-stone-100/40 dark:bg-zinc-800/40 border-t border-stone-200 dark:border-zinc-800">
        <p className="text-xs text-stone-400 dark:text-zinc-600">
          Last seen: <span className="text-stone-400 dark:text-zinc-500">{character.lastSeen}</span>
        </p>
      </div>
    </div>
    </>
  );
}
