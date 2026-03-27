'use client';

import { useEffect, useState } from 'react';
import type { AnalysisResult, NarrativeArc, ParentArc, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import NarrativeArcModal from '@/components/NarrativeArcModal';
import CharacterModal from '@/components/CharacterModal';
import LocationModal from '@/components/LocationModal';

interface Props {
  arcs: NarrativeArc[];
  snapshots: Snapshot[];
  chapterTitles: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (result: AnalysisResult, propagate?: SnapshotTransform) => void;
  arcChapterMap?: Map<string, number[]>;
  currentChapterIndex?: number;
  parentArcs?: ParentArc[];
  onUpdateParentArcs?: (parentArcs: ParentArc[]) => void;
}

const STATUS_CONFIG = {
  active:   { label: 'Active',   dot: 'bg-amber-500',   badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  dormant:  { label: 'Dormant',  dot: 'bg-stone-400',   badge: 'bg-stone-100 dark:bg-zinc-800 text-stone-400 dark:text-zinc-500 border-stone-200 dark:border-zinc-700' },
  resolved: { label: 'Resolved', dot: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
};

export default function ArcsPanel({ arcs, snapshots, chapterTitles, currentResult, onResultEdit, arcChapterMap: arcChapterMapProp, currentChapterIndex, parentArcs, onUpdateParentArcs }: Props) {
  const [selectedArc, setSelectedArc] = useState<string | null>(null);
  const [selectedCharName, setSelectedCharName] = useState<string | null>(null);
  const [selectedLocationName, setSelectedLocationName] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(parentArcs?.map((pa) => pa.name) ?? []));
  const [editingGroupName, setEditingGroupName] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');
  const [moveArc, setMoveArc] = useState<string | null>(null);

  useEffect(() => {
    if (parentArcs?.length) {
      setCollapsedGroups((prev) => {
        if (prev.size === 0) return new Set(parentArcs.map((pa) => pa.name));
        return prev;
      });
    }
  }, [parentArcs]);

  const handleEntityClick = (type: 'character' | 'location' | 'arc', name: string) => {
    setSelectedArc(type === 'arc' ? name : null);
    setSelectedCharName(type === 'character' ? name : null);
    setSelectedLocationName(type === 'location' ? name : null);
  };
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

  function renderArcCard(arc: NarrativeArc, showMoveAction = false) {
    const cfg = STATUS_CONFIG[arc.status];
    const chapters = arcChapterMap.get(arc.name) ?? [];
    const firstCh = chapters[0] ?? null;
    const lastCh = chapters[chapters.length - 1] ?? null;

    return (
      <div key={arc.name} className="relative group">
        <button
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
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); handleEntityClick('character', name); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleEntityClick('character', name); } }}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 border border-stone-200 dark:border-zinc-700 hover:underline cursor-pointer"
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
                <span>{firstCh !== null ? (chapterTitles[firstCh] ?? `Ch. ${firstCh + 1}`) : '—'}</span>
                {lastCh !== firstCh && lastCh !== null && (
                  <span>{chapterTitles[lastCh] ?? `Ch. ${lastCh + 1}`}</span>
                )}
              </div>
              <div className="w-full h-1.5 bg-stone-100 dark:bg-zinc-800 rounded-full overflow-hidden relative">
                <div
                  className={`absolute top-0 h-full rounded-full ${cfg.dot} opacity-60`}
                  style={{
                    left: `${((firstCh ?? 0) / totalChapters) * 100}%`,
                    width: `${Math.max(2, (((lastCh ?? firstCh ?? 0) - (firstCh ?? 0) + 1) / totalChapters) * 100)}%`,
                  }}
                />
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

        {/* Move action (shown in grouped view) */}
        {showMoveAction && parentArcs && parentArcs.length > 1 && (
          <div className="absolute top-3 right-12 z-10">
            <button
              onClick={(e) => { e.stopPropagation(); setMoveArc(moveArc === arc.name ? null : arc.name); }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded text-stone-400 hover:text-stone-600 dark:text-zinc-600 dark:hover:text-zinc-400 transition-all"
              title="Move to another group"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 9l4-4 4 4" /><path d="M9 5v12" /><path d="M15 19l4-4-4-4" /><path d="M19 15H7" />
              </svg>
            </button>
            {moveArc === arc.name && (
              <div className="absolute top-8 right-0 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[160px] z-20">
                {parentArcs.filter((pa) => !pa.children.includes(arc.name)).map((pa) => (
                  <button
                    key={pa.name}
                    onClick={(e) => { e.stopPropagation(); handleMoveArc(arc.name, pa.name); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-800"
                  >
                    {pa.name}
                  </button>
                ))}
                <button
                  onClick={(e) => { e.stopPropagation(); handleMoveArcToNew(arc.name); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-amber-500 hover:bg-stone-100 dark:hover:bg-zinc-800 border-t border-stone-100 dark:border-zinc-800"
                >
                  + New group...
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function handleMoveArc(arcName: string, targetParent: string) {
    if (!parentArcs || !onUpdateParentArcs) return;
    const updated = parentArcs.map((pa) => ({
      ...pa,
      children: pa.children.includes(arcName)
        ? pa.children.filter((c) => c !== arcName)
        : pa.name === targetParent
          ? [...pa.children, arcName]
          : pa.children,
    })).filter((pa) => pa.children.length > 0);
    onUpdateParentArcs(updated);
    setMoveArc(null);
  }

  function handleMoveArcToNew(arcName: string) {
    if (!parentArcs || !onUpdateParentArcs) return;
    const newName = prompt('New group name:');
    if (!newName?.trim()) { setMoveArc(null); return; }
    const updated = parentArcs.map((pa) => ({
      ...pa,
      children: pa.children.filter((c) => c !== arcName),
    })).filter((pa) => pa.children.length > 0);
    updated.push({ name: newName.trim(), children: [arcName], summary: '' });
    onUpdateParentArcs(updated);
    setMoveArc(null);
  }

  function handleRenameGroup(oldName: string, newName: string) {
    if (!parentArcs || !onUpdateParentArcs || !newName.trim()) return;
    const updated = parentArcs.map((pa) =>
      pa.name === oldName ? { ...pa, name: newName.trim() } : pa
    );
    onUpdateParentArcs(updated);
    setEditingGroupName(null);
  }

  return (
    <>
    {selectedArc && (
      <NarrativeArcModal
        arcName={selectedArc}
        snapshots={snapshots}
        chapterTitles={chapterTitles}
        currentResult={currentResult}
        onResultEdit={onResultEdit}
        currentChapterIndex={currentChapterIndex}
        onClose={() => setSelectedArc(null)}
        onEntityClick={handleEntityClick}
      />
    )}
    {selectedCharName && (() => {
      const character = currentResult?.characters.find((c) => c.name === selectedCharName);
      return character ? (
        <CharacterModal
          character={character}
          snapshots={snapshots}
          chapterTitles={chapterTitles}
          currentResult={currentResult}
          onResultEdit={onResultEdit}
          currentChapterIndex={currentChapterIndex}
          onClose={() => setSelectedCharName(null)}
          onEntityClick={handleEntityClick}
        />
      ) : null;
    })()}
    {selectedLocationName && (
      <LocationModal
        locationName={selectedLocationName}
        snapshots={snapshots}
        chapterTitles={chapterTitles}
        currentResult={currentResult}
        onResultEdit={onResultEdit}
        currentChapterIndex={currentChapterIndex}
        onClose={() => setSelectedLocationName(null)}
        onEntityClick={handleEntityClick}
      />
    )}
    <div className="space-y-4">
      {parentArcs?.length ? (
        // Grouped view
        (() => {
          const statusOrder = { active: 0, dormant: 1, resolved: 2 };
          const arcMap = new Map(arcs.map((a) => [a.name, a]));
          const sortedParents = [...parentArcs].sort((a, b) => {
            const aStatus = Math.min(...a.children.map((c) => statusOrder[arcMap.get(c)?.status ?? 'resolved'] ?? 2));
            const bStatus = Math.min(...b.children.map((c) => statusOrder[arcMap.get(c)?.status ?? 'resolved'] ?? 2));
            return aStatus !== bStatus ? aStatus - bStatus : b.children.length - a.children.length;
          });
          return sortedParents.map((pa) => {
            const isCollapsed = collapsedGroups.has(pa.name);
            const childArcs = pa.children.map((c) => arcMap.get(c)).filter((a): a is NarrativeArc => !!a);
            const bestStatus = childArcs.reduce<NarrativeArc['status']>((best, a) =>
              statusOrder[a.status] < statusOrder[best] ? a.status : best, 'resolved');
            const cfg = STATUS_CONFIG[bestStatus];

            return (
              <div key={pa.name} className="rounded-xl border border-stone-200 dark:border-zinc-800 overflow-hidden">
                {/* Parent header */}
                <button
                  onClick={() => setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    next.has(pa.name) ? next.delete(pa.name) : next.add(pa.name);
                    return next;
                  })}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 bg-stone-50 dark:bg-zinc-900/50 hover:bg-stone-100 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <svg
                    width="12" height="12" viewBox="0 0 12 12" fill="currentColor"
                    className={`text-stone-400 dark:text-zinc-600 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  >
                    <path d="M4 2l4 4-4 4" />
                  </svg>
                  <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                  {editingGroupName === pa.name ? (
                    <input
                      autoFocus
                      className="text-sm font-semibold bg-transparent border-b border-amber-500 outline-none text-stone-800 dark:text-zinc-100"
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      onBlur={() => handleRenameGroup(pa.name, editNameValue)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameGroup(pa.name, editNameValue); if (e.key === 'Escape') setEditingGroupName(null); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="text-sm font-semibold text-stone-800 dark:text-zinc-100 cursor-text"
                      onDoubleClick={(e) => { e.stopPropagation(); setEditingGroupName(pa.name); setEditNameValue(pa.name); }}
                    >
                      {pa.name}
                    </span>
                  )}
                  <span className="text-[11px] text-stone-400 dark:text-zinc-600">
                    {childArcs.length} arc{childArcs.length !== 1 ? 's' : ''}
                  </span>
                  {isCollapsed && pa.summary && (
                    <span className="ml-auto text-xs text-stone-400 dark:text-zinc-600 truncate max-w-[200px]">{pa.summary}</span>
                  )}
                </button>

                {/* Expanded children */}
                {!isCollapsed && (
                  <div className="p-3 space-y-3 bg-white dark:bg-zinc-900">
                    {pa.summary && (
                      <p className="text-xs text-stone-400 dark:text-zinc-500 leading-relaxed px-1">{pa.summary}</p>
                    )}
                    {childArcs.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]).map((arc) => renderArcCard(arc, true))}
                  </div>
                )}
              </div>
            );
          });
        })()
      ) : (
        // Flat view (no parent arcs)
        sorted.map((arc) => renderArcCard(arc))
      )}
    </div>
    </>
  );
}
