'use client';

import { useEffect, useState } from 'react';
import type { AnalysisResult, LocationInfo, LocationRelationship, PinUpdates, Snapshot } from '@/types';
import { applyLocationReconciliation } from '@/lib/reconcile';
import { renameLocation, mergeLocations, splitLocation, deleteLocation, setParentLocation } from '@/lib/propagate-edit';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import EntityPicker from './EntityPicker';

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

const STATUS_DOT: Record<string, string> = {
  alive: 'bg-emerald-400',
  dead: 'bg-red-400',
  unknown: 'bg-stone-400 dark:bg-zinc-500',
  uncertain: 'bg-amber-400',
};

interface TimelineEntry {
  chapterIndex: number;
  locationEvents?: string;
  characters: { name: string; status: string }[];
}

type EditMode = 'view' | 'edit' | 'merge' | 'split' | 'delete';

interface DraftLocation {
  name: string;
  aliases: string;
  parentLocation: string;
  description: string;
  recentEvents: string;
  relationships: LocationRelationship[];
}

function locToDraft(loc: { name: string; aliases?: string[]; parentLocation?: string; description?: string; recentEvents?: string; relationships?: LocationRelationship[] }): DraftLocation {
  return {
    name: loc.name,
    aliases: (loc.aliases ?? []).join(', '),
    parentLocation: loc.parentLocation ?? '',
    description: loc.description ?? '',
    recentEvents: loc.recentEvents ?? '',
    relationships: [...(loc.relationships ?? [])],
  };
}

interface Props {
  locationName: string;
  snapshots: Snapshot[];
  chapterTitles?: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (r: AnalysisResult, propagate?: SnapshotTransform, pinUpdates?: PinUpdates) => void;
  onClose: () => void;
}

export default function LocationModal({ locationName, snapshots, chapterTitles, currentResult, onResultEdit, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview');
  const [mode, setMode] = useState<EditMode>('view');

  const canEdit = !!currentResult && !!onResultEdit;

  // Find the most recent LocationInfo for description + arc + relationships
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  let description = '';
  let arc = '';
  let aliases: string[] = [];
  let relationships: LocationRelationship[] = [];
  let recentEvents = '';
  for (const snap of sorted) {
    const info = snap.result.locations?.find(
      (l) => l.name?.toLowerCase().trim() === locationName.toLowerCase().trim(),
    );
    if (info?.description) description = info.description;
    if (info?.arc) arc = info.arc;
    if (info?.aliases?.length) aliases = info.aliases;
    if (info?.relationships?.length) relationships = info.relationships;
    if (info?.recentEvents) recentEvents = info.recentEvents;
  }

  // Also get from currentResult if available
  const currentLoc = currentResult?.locations?.find(
    (l) => l.name?.toLowerCase().trim() === locationName.toLowerCase().trim(),
  );
  if (currentLoc) {
    if (currentLoc.description) description = currentLoc.description;
    if (currentLoc.arc) arc = currentLoc.arc;
    if (currentLoc.aliases?.length) aliases = currentLoc.aliases;
    if (currentLoc.relationships?.length) relationships = currentLoc.relationships;
    if (currentLoc.recentEvents) recentEvents = currentLoc.recentEvents;
  }

  const [draft, setDraft] = useState<DraftLocation>(() =>
    locToDraft({ name: locationName, aliases, parentLocation: currentLoc?.parentLocation, description, recentEvents, relationships }),
  );
  const [splitA, setSplitA] = useState<DraftLocation>(() =>
    locToDraft({ name: locationName, aliases, parentLocation: currentLoc?.parentLocation, description, recentEvents, relationships }),
  );
  const [splitB, setSplitB] = useState<DraftLocation>(() =>
    locToDraft({ name: locationName, aliases, parentLocation: currentLoc?.parentLocation, description, recentEvents, relationships }),
  );

  // Characters currently here (from latest snapshot)
  const latestSnap = sorted[sorted.length - 1];
  const currentChars = latestSnap?.result.characters.filter(
    (c) => c.currentLocation?.trim().toLowerCase() === locationName.toLowerCase().trim(),
  ) ?? [];

  // Build timeline
  const timeline: TimelineEntry[] = [];
  let prevCharNames = new Set<string>();
  for (const snap of sorted) {
    const locInfo = snap.result.locations?.find(
      (l) => l.name?.toLowerCase().trim() === locationName.toLowerCase().trim(),
    );
    const present = snap.result.characters.filter(
      (c) => c.currentLocation?.trim().toLowerCase() === locationName.toLowerCase().trim(),
    );
    const curNames = new Set(present.map((c) => c.name));
    const charsChanged = present.length !== prevCharNames.size || [...curNames].some((n) => !prevCharNames.has(n));
    const hasEvents = !!locInfo?.recentEvents;
    if (present.length > 0 && (charsChanged || hasEvents)) {
      timeline.push({
        chapterIndex: snap.index,
        locationEvents: locInfo?.recentEvents,
        characters: present.map((c) => ({ name: c.name, status: c.status })),
      });
    }
    prevCharNames = present.length > 0 ? curNames : new Set();
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
    const oldName = locationName;
    const newName = draft.name.trim();
    const newAliases = draft.aliases.split(',').map((s) => s.trim()).filter(Boolean);
    const newParent = draft.parentLocation.trim() || undefined;
    const oldParent = currentLoc?.parentLocation;
    const parentChanged = (newParent ?? '') !== (oldParent ?? '');

    const locations = (currentResult.locations ?? []).map((l) => {
      if (l.name.toLowerCase().trim() !== oldName.toLowerCase().trim()) {
        // Update relationship references if name changed
        if (oldName !== newName && l.relationships?.length) {
          return {
            ...l,
            relationships: l.relationships.map((r) => ({
              ...r,
              location: r.location.toLowerCase() === oldName.toLowerCase() ? newName : r.location,
            })),
          };
        }
        return l;
      }
      return {
        ...l,
        name: newName,
        aliases: newAliases.length > 0 ? newAliases : undefined,
        parentLocation: newParent,
        description: draft.description.trim(),
        recentEvents: draft.recentEvents.trim() || undefined,
        relationships: draft.relationships.length > 0 ? draft.relationships : undefined,
      };
    });

    // Update character currentLocation references
    const characters = oldName !== newName
      ? currentResult.characters.map((c) =>
          c.currentLocation?.toLowerCase().trim() === oldName.toLowerCase().trim()
            ? { ...c, currentLocation: newName }
            : c,
        )
      : currentResult.characters;

    // Build propagation transform
    const transforms: Array<(r: AnalysisResult) => AnalysisResult> = [];
    if (oldName !== newName) transforms.push(renameLocation(oldName, newName));
    if (parentChanged) transforms.push(setParentLocation(newName, newParent));
    const propagate = transforms.length > 0
      ? (r: AnalysisResult) => transforms.reduce((acc, fn) => fn(acc), r)
      : undefined;

    const pins: PinUpdates | undefined = oldName !== newName ? { renames: { [oldName]: newName } } : undefined;
    onResultEdit({ ...currentResult, locations, characters }, propagate, pins);
    onClose();
  }

  function handleMerge(targetName: string) {
    if (!currentResult || !onResultEdit) return;
    const locs = currentResult.locations ?? [];
    const idxA = locs.findIndex((l) => l.name.toLowerCase().trim() === locationName.toLowerCase().trim());
    const idxB = locs.findIndex((l) => l.name === targetName);
    if (idxB < 0) return;

    if (idxA >= 0) {
      // Both exist in result.locations — full reconciliation merge
      const locB = locs[idxB];
      const mergeGroup = {
        primary: idxA,
        absorb: [idxB],
        reason: 'Manual merge',
        combinedAliases: [...(aliases ?? []), locB.name, ...(locB.aliases ?? [])],
      };
      const { locations: newLocs, characters } = applyLocationReconciliation(
        locs, currentResult.characters, { mergeGroups: [mergeGroup], splits: [] },
      );
      onResultEdit(
        { ...currentResult, locations: newLocs, characters },
        mergeLocations(locationName, targetName),
        { renames: { [targetName]: locationName } },
      );
    } else {
      // Source is character-only (no LocationInfo entry) — absorb into target
      const target = locs[idxB];
      const newAlias = locationName.trim();
      const updatedAliases = [...new Set([...(target.aliases ?? []), newAlias].filter(Boolean))];
      const locations = locs.map((l) =>
        l.name === targetName ? { ...l, aliases: updatedAliases.length > 0 ? updatedAliases : undefined } : l,
      );
      const characters = currentResult.characters.map((c) =>
        c.currentLocation?.toLowerCase().trim() === locationName.toLowerCase().trim()
          ? { ...c, currentLocation: targetName }
          : c,
      );
      onResultEdit(
        { ...currentResult, locations, characters },
        mergeLocations(targetName, locationName),
        { renames: { [locationName]: targetName } },
      );
    }
    onClose();
  }

  function handleSplit() {
    if (!currentResult || !onResultEdit) return;
    const locs = currentResult.locations ?? [];
    const idx = locs.findIndex((l) => l.name.toLowerCase().trim() === locationName.toLowerCase().trim());
    if (idx < 0) return;

    const split = {
      sourceIndex: idx,
      reason: 'Manual split',
      newEntries: [
        { name: splitA.name.trim(), aliases: splitA.aliases.split(',').map((s) => s.trim()).filter(Boolean), description: splitA.description.trim() },
        { name: splitB.name.trim(), aliases: splitB.aliases.split(',').map((s) => s.trim()).filter(Boolean), description: splitB.description.trim() },
      ],
    };
    const { locations: newLocs, characters } = applyLocationReconciliation(
      locs, currentResult.characters, { mergeGroups: [], splits: [split] },
    );
    onResultEdit({ ...currentResult, locations: newLocs, characters }, splitLocation(locationName, splitA.name.trim(), splitB.name.trim()));
    onClose();
  }

  function handleDelete() {
    if (!currentResult || !onResultEdit) return;
    const locations = (currentResult.locations ?? []).filter(
      (l) => l.name.toLowerCase().trim() !== locationName.toLowerCase().trim(),
    ).map((l) => ({
      ...l,
      relationships: l.relationships?.filter((r) => r.location.toLowerCase().trim() !== locationName.toLowerCase().trim()),
    }));
    const characters = currentResult.characters.map((c) =>
      c.currentLocation?.toLowerCase().trim() === locationName.toLowerCase().trim()
        ? { ...c, currentLocation: 'Unknown' }
        : c,
    );
    onResultEdit({ ...currentResult, locations, characters }, deleteLocation(locationName), { deletes: [locationName] });
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
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Parent Location</label>
          <select
            value={draft.parentLocation}
            onChange={(e) => setDraft({ ...draft, parentLocation: e.target.value })}
            className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-white dark:bg-zinc-900 outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500"
          >
            <option value="">None</option>
            {(currentResult?.locations ?? [])
              .filter((l) => l.name.toLowerCase().trim() !== locationName.toLowerCase().trim())
              .map((l) => (
                <option key={l.name} value={l.name}>{l.name}</option>
              ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Aliases (comma-separated)</label>
          <input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500" />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Description</label>
          <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500 resize-none" />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Recent Events</label>
          <textarea value={draft.recentEvents} onChange={(e) => setDraft({ ...draft, recentEvents: e.target.value })} rows={2} className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500 resize-none" />
        </div>
        {/* Relationships */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Relationships</label>
            <button onClick={() => setDraft({ ...draft, relationships: [...draft.relationships, { location: '', relationship: '' }] })} className="text-[10px] text-amber-500 hover:text-amber-400 font-medium">+ Add</button>
          </div>
          <div className="mt-1 space-y-1.5">
            {draft.relationships.map((rel, i) => (
              <div key={i} className="flex gap-1.5 items-center">
                <input
                  value={rel.location}
                  onChange={(e) => { const rels = [...draft.relationships]; rels[i] = { ...rels[i], location: e.target.value }; setDraft({ ...draft, relationships: rels }); }}
                  placeholder="Location"
                  className="flex-1 text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200"
                />
                <input
                  value={rel.relationship}
                  onChange={(e) => { const rels = [...draft.relationships]; rels[i] = { ...rels[i], relationship: e.target.value }; setDraft({ ...draft, relationships: rels }); }}
                  placeholder="Relationship"
                  className="flex-1 text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200"
                />
                <button onClick={() => setDraft({ ...draft, relationships: draft.relationships.filter((_, j) => j !== i) })} className="text-stone-400 hover:text-red-400 text-xs flex-shrink-0">✕</button>
              </div>
            ))}
          </div>
        </div>
        {/* Action buttons */}
        <div className="flex gap-2 pt-2">
          <button onClick={handleSaveEdit} className="flex-1 text-xs py-2 rounded-lg bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 transition-colors">Save</button>
          <button onClick={() => { setDraft(locToDraft({ name: locationName, aliases, parentLocation: currentLoc?.parentLocation, description, recentEvents, relationships })); setMode('view'); }} className="flex-1 text-xs py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">Cancel</button>
        </div>
        <div className="flex gap-2 border-t border-stone-200 dark:border-zinc-800 pt-3">
          <button onClick={() => setMode('merge')} className="text-[11px] px-2.5 py-1 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-amber-500 hover:border-amber-500/40 transition-colors">Merge with...</button>
          <button onClick={() => { const d = locToDraft({ name: locationName, aliases, parentLocation: currentLoc?.parentLocation, description, recentEvents, relationships }); setSplitA(d); setSplitB(d); setMode('split'); }} className="text-[11px] px-2.5 py-1 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-violet-400 hover:border-violet-400/40 transition-colors">Split into two...</button>
          <button onClick={() => setMode('delete')} className="ml-auto text-[11px] px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
        </div>
      </div>
    );
  }

  function renderSplitForm() {
    const renderHalf = (label: string, d: DraftLocation, setD: (d: DraftLocation) => void) => (
      <div className="flex-1 space-y-2">
        <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">{label}</p>
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Name" className="w-full text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200" />
        <input value={d.aliases} onChange={(e) => setD({ ...d, aliases: e.target.value })} placeholder="Aliases" className="w-full text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200" />
        <textarea value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Description" rows={3} className="w-full text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 resize-none" />
      </div>
    );
    const canConfirm = splitA.name.trim() && splitB.name.trim() && splitA.name.trim() !== splitB.name.trim();
    return (
      <div className="space-y-4">
        <p className="text-xs text-stone-400 dark:text-zinc-500">Split <strong className="text-stone-700 dark:text-zinc-300">{locationName}</strong> into two locations.</p>
        <div className="flex gap-3">
          {renderHalf('Location A', splitA, setSplitA)}
          <div className="w-px bg-stone-200 dark:bg-zinc-800 flex-shrink-0" />
          {renderHalf('Location B', splitB, setSplitB)}
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
        <p className="text-sm text-stone-700 dark:text-zinc-300">Delete <strong>{locationName}</strong>? This cannot be undone.</p>
        <p className="text-xs text-stone-400 dark:text-zinc-500">Characters at this location will have their location set to &quot;Unknown&quot;.</p>
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
          items={(currentResult.locations ?? [])
            .filter((l) => l.name.toLowerCase().trim() !== locationName.toLowerCase().trim())
            .map((l) => ({ name: l.name, aliases: l.aliases, description: l.description }))}
          label={`Merge "${locationName}" with...`}
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
                📍
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h2 className="text-lg font-bold text-stone-900 dark:text-zinc-100 leading-tight">{locationName}</h2>
                    {aliases.length > 0 && (
                      <p className="text-xs text-stone-400 dark:text-zinc-500 mt-0.5">aka {aliases.join(', ')}</p>
                    )}
                    {arc && (
                      <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                        {arc}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {canEdit && mode === 'view' && (
                      <button
                        onClick={() => { setDraft(locToDraft({ name: locationName, aliases, parentLocation: currentLoc?.parentLocation, description, recentEvents, relationships })); setMode('edit'); setTab('overview'); }}
                        className="flex-shrink-0 text-stone-400 dark:text-zinc-600 hover:text-amber-500 transition-colors text-sm leading-none p-1"
                        title="Edit location"
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
                {mode === 'view' && (
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {currentChars.length > 0 && (
                      <span className="text-xs px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                        {currentChars.length} character{currentChars.length !== 1 ? 's' : ''} here
                      </span>
                    )}
                    {currentChars.length === 0 && (
                      <span className="text-xs text-stone-400 dark:text-zinc-500">No characters currently here</span>
                    )}
                  </div>
                )}
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
                {description ? (
                  <section>
                    <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">About</p>
                    <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{description}</p>
                  </section>
                ) : (
                  <p className="text-sm text-stone-400 dark:text-zinc-600 italic">No description available — analyze more chapters to populate.</p>
                )}

                {currentChars.length > 0 && (
                  <section>
                    <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Currently here</p>
                    <ul className="space-y-2">
                      {currentChars.map((c) => (
                        <li key={c.name} className="flex items-start gap-3">
                          <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(c.name)}`}>
                            {initials(c.name)}
                          </div>
                          <div className="flex-1 min-w-0 pt-0.5">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{c.name}</span>
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[c.status] ?? STATUS_DOT.unknown}`} />
                            </div>
                            {c.recentEvents && (
                              <p className="text-xs text-stone-400 dark:text-zinc-500 mt-0.5 line-clamp-2">{c.recentEvents}</p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {relationships.length > 0 && (
                  <section>
                    <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">Related Places</p>
                    <ul className="space-y-1.5">
                      {relationships.map((r) => (
                        <li key={r.location} className="flex items-center gap-2 text-sm">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 flex-shrink-0">{r.relationship}</span>
                          <span className="text-stone-700 dark:text-zinc-300">{r.location}</span>
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
                  Visitor history · newest first
                </p>
                {timelineReversed.length === 0 ? (
                  <p className="text-sm text-stone-400 dark:text-zinc-600 text-center py-6">No history yet.</p>
                ) : (
                  <ol className="relative border-l border-stone-200 dark:border-zinc-800 space-y-0">
                    {timelineReversed.map((entry, i) => (
                      <li key={i} className="pl-5 pb-6 last:pb-0 relative">
                        <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-stone-200 dark:bg-zinc-700 border border-stone-300 dark:border-zinc-600" />
                        <p className="text-[11px] font-semibold text-stone-400 dark:text-zinc-500 mb-2">
                          Ch. {entry.chapterIndex + 1}{chapterTitles?.[entry.chapterIndex] ? ` — ${chapterTitles[entry.chapterIndex]}` : ''}
                        </p>
                        {entry.locationEvents && (
                          <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed mb-2">{entry.locationEvents}</p>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {entry.characters.map((c) => (
                            <span key={c.name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-medium ${nameColor(c.name)}`}>
                              <span className={`w-1 h-1 rounded-full flex-shrink-0 ${STATUS_DOT[c.status] ?? STATUS_DOT.unknown}`} />
                              {c.name}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
