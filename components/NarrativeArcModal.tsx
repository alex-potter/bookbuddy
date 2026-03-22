'use client';

import { useEffect, useState } from 'react';
import type { AnalysisResult, NarrativeArc, Snapshot } from '@/types';
import { renameArc, mergeArcs, splitArc, deleteArc } from '@/lib/propagate-edit';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import EntityPicker from './EntityPicker';

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

type EditMode = 'view' | 'edit' | 'merge' | 'split' | 'delete';

interface DraftArc {
  name: string;
  status: NarrativeArc['status'];
  characters: string;
  summary: string;
}

function arcToDraft(arc: { name: string; status: NarrativeArc['status']; characters: string[]; summary: string }): DraftArc {
  return {
    name: arc.name,
    status: arc.status,
    characters: arc.characters.join(', '),
    summary: arc.summary,
  };
}

interface Props {
  arcName: string;
  snapshots: Snapshot[];
  chapterTitles?: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (r: AnalysisResult, propagate?: SnapshotTransform) => void;
  onClose: () => void;
}

export default function NarrativeArcModal({ arcName, snapshots, chapterTitles, currentResult, onResultEdit, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview');
  const [mode, setMode] = useState<EditMode>('view');

  const canEdit = !!currentResult && !!onResultEdit;
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);

  // Collect arc data across all snapshots
  let summary = '';
  let status: NarrativeArc['status'] = 'active';
  let characters: string[] = [];
  for (const snap of sorted) {
    const arc = snap.result.arcs?.find((a) => a.name?.toLowerCase().trim() === arcName.toLowerCase().trim());
    if (arc?.summary) summary = arc.summary;
    if (arc?.status) status = arc.status;
    if (arc?.characters?.length) characters = arc.characters;
  }
  // Prefer currentResult
  const currentArc = currentResult?.arcs?.find((a) => a.name?.toLowerCase().trim() === arcName.toLowerCase().trim());
  if (currentArc) {
    if (currentArc.summary) summary = currentArc.summary;
    if (currentArc.status) status = currentArc.status;
    if (currentArc.characters?.length) characters = currentArc.characters;
  }

  const [draft, setDraft] = useState<DraftArc>(() => arcToDraft({ name: arcName, status, characters, summary }));
  const [splitA, setSplitA] = useState<DraftArc>(() => arcToDraft({ name: arcName, status, characters, summary }));
  const [splitB, setSplitB] = useState<DraftArc>(() => arcToDraft({ name: arcName, status, characters, summary }));

  // Locations belonging to this arc
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

  // Timeline
  interface TimelineEntry { chapterIndex: number; summary: string; status: string; charCount: number; }
  const timeline: TimelineEntry[] = [];
  for (const snap of sorted) {
    const arc = snap.result.arcs?.find((a) => a.name?.toLowerCase().trim() === arcName.toLowerCase().trim());
    if (arc?.summary) {
      timeline.push({ chapterIndex: snap.index, summary: arc.summary, status: arc.status ?? 'active', charCount: arc.characters?.length ?? 0 });
    }
  }
  const timelineReversed = [...timeline].reverse();

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { if (mode !== 'view') setMode('view'); else onClose(); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, mode]);

  // ── Save helpers ──

  function handleSaveEdit() {
    if (!currentResult || !onResultEdit) return;
    const oldName = arcName;
    const newName = draft.name.trim();
    const newChars = draft.characters.split(',').map((s) => s.trim()).filter(Boolean);

    const arcs = (currentResult.arcs ?? []).map((a) => {
      if (a.name.toLowerCase().trim() !== oldName.toLowerCase().trim()) return a;
      return { ...a, name: newName, status: draft.status, characters: newChars, summary: draft.summary.trim() };
    });

    // Update location arc references if name changed
    let locations = currentResult.locations;
    if (oldName !== newName && locations) {
      locations = locations.map((l) =>
        l.arc?.toLowerCase().trim() === oldName.toLowerCase().trim()
          ? { ...l, arc: newName }
          : l,
      );
    }

    const propagate = oldName !== newName ? renameArc(oldName, newName) : undefined;
    onResultEdit({ ...currentResult, arcs, locations }, propagate);
    onClose();
  }

  function handleMerge(targetName: string) {
    if (!currentResult || !onResultEdit) return;
    const arcs = currentResult.arcs ?? [];
    const arcA = arcs.find((a) => a.name.toLowerCase().trim() === arcName.toLowerCase().trim());
    const arcB = arcs.find((a) => a.name === targetName);
    if (!arcA || !arcB) return;

    // Combine: take longer summary, merge characters, prefer active > dormant > resolved
    const statusOrder: Record<string, number> = { active: 3, dormant: 2, resolved: 1 };
    const mergedStatus = (statusOrder[arcA.status] ?? 0) >= (statusOrder[arcB.status] ?? 0) ? arcA.status : arcB.status;
    const mergedChars = [...new Set([...arcA.characters, ...arcB.characters])];
    const mergedSummary = (arcA.summary?.length ?? 0) >= (arcB.summary?.length ?? 0) ? arcA.summary : arcB.summary;

    const newArcs = arcs
      .filter((a) => a.name !== targetName)
      .map((a) => {
        if (a.name.toLowerCase().trim() !== arcName.toLowerCase().trim()) return a;
        return { ...a, status: mergedStatus, characters: mergedChars, summary: mergedSummary };
      });

    // Update location arc references
    let locations = currentResult.locations;
    if (locations) {
      locations = locations.map((l) =>
        l.arc?.toLowerCase().trim() === targetName.toLowerCase().trim()
          ? { ...l, arc: arcA.name }
          : l,
      );
    }

    onResultEdit({ ...currentResult, arcs: newArcs, locations }, mergeArcs(arcName, targetName));
    onClose();
  }

  function handleSplit() {
    if (!currentResult || !onResultEdit) return;
    const arcs = currentResult.arcs ?? [];
    const newArcs = arcs.flatMap((a) => {
      if (a.name.toLowerCase().trim() !== arcName.toLowerCase().trim()) return [a];
      return [
        { name: splitA.name.trim(), status: splitA.status, characters: splitA.characters.split(',').map((s) => s.trim()).filter(Boolean), summary: splitA.summary.trim() },
        { name: splitB.name.trim(), status: splitB.status, characters: splitB.characters.split(',').map((s) => s.trim()).filter(Boolean), summary: splitB.summary.trim() },
      ];
    });
    onResultEdit({ ...currentResult, arcs: newArcs }, splitArc(arcName, splitA.name.trim(), splitB.name.trim()));
    onClose();
  }

  function handleDelete() {
    if (!currentResult || !onResultEdit) return;
    const arcs = (currentResult.arcs ?? []).filter(
      (a) => a.name.toLowerCase().trim() !== arcName.toLowerCase().trim(),
    );
    // Clear arc field on locations referencing this arc
    let locations = currentResult.locations;
    if (locations) {
      locations = locations.map((l) =>
        l.arc?.toLowerCase().trim() === arcName.toLowerCase().trim()
          ? { ...l, arc: undefined }
          : l,
      );
    }
    onResultEdit({ ...currentResult, arcs, locations }, deleteArc(arcName));
    onClose();
  }

  // ── Render helpers ──

  function renderEditForm() {
    return (
      <div className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Name</label>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500" />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Status</label>
          <div className="flex gap-1 mt-1">
            {(['active', 'dormant', 'resolved'] as const).map((val) => (
              <button
                key={val}
                onClick={() => setDraft({ ...draft, status: val })}
                className={`flex-1 text-xs py-1.5 rounded-lg border font-medium transition-colors ${
                  draft.status === val
                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                    : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-500 hover:text-stone-600 dark:hover:text-zinc-300'
                }`}
              >
                {val.charAt(0).toUpperCase() + val.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Characters (comma-separated)</label>
          <input value={draft.characters} onChange={(e) => setDraft({ ...draft, characters: e.target.value })} className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500" />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Summary</label>
          <textarea value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} rows={3} className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500 resize-none" />
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={handleSaveEdit} className="flex-1 text-xs py-2 rounded-lg bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 transition-colors">Save</button>
          <button onClick={() => { setDraft(arcToDraft({ name: arcName, status, characters, summary })); setMode('view'); }} className="flex-1 text-xs py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">Cancel</button>
        </div>
        <div className="flex gap-2 border-t border-stone-200 dark:border-zinc-800 pt-3">
          <button onClick={() => setMode('merge')} className="text-[11px] px-2.5 py-1 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-amber-500 hover:border-amber-500/40 transition-colors">Merge with...</button>
          <button onClick={() => { const d = arcToDraft({ name: arcName, status, characters, summary }); setSplitA(d); setSplitB(d); setMode('split'); }} className="text-[11px] px-2.5 py-1 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-violet-400 hover:border-violet-400/40 transition-colors">Split into two...</button>
          <button onClick={() => setMode('delete')} className="ml-auto text-[11px] px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
        </div>
      </div>
    );
  }

  function renderSplitForm() {
    const renderHalf = (label: string, d: DraftArc, setD: (d: DraftArc) => void) => (
      <div className="flex-1 space-y-2">
        <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">{label}</p>
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Name" className="w-full text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200" />
        <div className="flex gap-1">
          {(['active', 'dormant', 'resolved'] as const).map((val) => (
            <button key={val} onClick={() => setD({ ...d, status: val })} className={`flex-1 text-[10px] py-1 rounded border font-medium ${d.status === val ? 'bg-amber-500/20 text-amber-400 border-amber-500/40' : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-500'}`}>{val}</button>
          ))}
        </div>
        <input value={d.characters} onChange={(e) => setD({ ...d, characters: e.target.value })} placeholder="Characters" className="w-full text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200" />
        <textarea value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} placeholder="Summary" rows={3} className="w-full text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 resize-none" />
      </div>
    );
    const canConfirm = splitA.name.trim() && splitB.name.trim() && splitA.name.trim() !== splitB.name.trim();
    return (
      <div className="space-y-4">
        <p className="text-xs text-stone-400 dark:text-zinc-500">Split <strong className="text-stone-700 dark:text-zinc-300">{arcName}</strong> into two arcs.</p>
        <div className="flex gap-3">
          {renderHalf('Arc A', splitA, setSplitA)}
          <div className="w-px bg-stone-200 dark:bg-zinc-800 flex-shrink-0" />
          {renderHalf('Arc B', splitB, setSplitB)}
        </div>
        <div className="flex gap-2">
          <button onClick={handleSplit} disabled={!canConfirm} className="flex-1 text-xs py-2 rounded-lg bg-violet-500 text-white font-semibold hover:bg-violet-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Split</button>
          <button onClick={() => setMode('edit')} className="flex-1 text-xs py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }

  function renderDeleteConfirm() {
    return (
      <div className="space-y-4 text-center py-4">
        <p className="text-sm text-stone-700 dark:text-zinc-300">Delete <strong>{arcName}</strong>? This cannot be undone.</p>
        <p className="text-xs text-stone-400 dark:text-zinc-500">The arc field will be cleared on locations referencing this arc.</p>
        <div className="flex gap-2 justify-center">
          <button onClick={handleDelete} className="text-xs px-4 py-2 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-400 transition-colors">Confirm Delete</button>
          <button onClick={() => setMode('edit')} className="text-xs px-4 py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {mode === 'merge' && currentResult && (
        <EntityPicker
          items={(currentResult.arcs ?? [])
            .filter((a) => a.name.toLowerCase().trim() !== arcName.toLowerCase().trim())
            .map((a) => ({ name: a.name, description: a.summary }))}
          label={`Merge "${arcName}" with...`}
          onSelect={handleMerge}
          onClose={() => setMode('edit')}
        />
      )}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={mode === 'view' ? onClose : undefined}>
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={mode !== 'view' ? () => setMode('view') : undefined} />

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
                    {mode === 'view' && (
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
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {canEdit && mode === 'view' && (
                      <button
                        onClick={() => { setDraft(arcToDraft({ name: arcName, status, characters, summary })); setMode('edit'); setTab('overview'); }}
                        className="flex-shrink-0 text-stone-400 dark:text-zinc-600 hover:text-amber-500 transition-colors text-sm leading-none p-1"
                        title="Edit arc"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                      </button>
                    )}
                    <button
                      onClick={mode !== 'view' ? () => setMode('view') : onClose}
                      className="flex-shrink-0 text-stone-400 dark:text-zinc-600 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors text-lg leading-none"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {mode === 'view' && (
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
            )}
            {mode !== 'view' && (
              <div className="mt-3 mb-0">
                <span className="text-xs font-semibold text-amber-500 uppercase tracking-wider">
                  {mode === 'edit' ? 'Editing' : mode === 'split' ? 'Split' : mode === 'delete' ? 'Delete' : 'Merge'}
                </span>
              </div>
            )}
          </div>

          <div className="p-6 space-y-5">
            {mode === 'edit' && renderEditForm()}
            {mode === 'split' && renderSplitForm()}
            {mode === 'delete' && renderDeleteConfirm()}

            {mode === 'view' && tab === 'overview' && (
              <>
                {summary ? (
                  <section>
                    <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">Current State</p>
                    <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{summary}</p>
                  </section>
                ) : (
                  <p className="text-sm text-stone-400 dark:text-zinc-600 italic">No summary yet — analyze more chapters to populate.</p>
                )}

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
            )}

            {mode === 'view' && tab === 'timeline' && (
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
    </>
  );
}
