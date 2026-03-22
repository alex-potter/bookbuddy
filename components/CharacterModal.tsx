'use client';

import { useEffect, useState } from 'react';
import type { AnalysisResult, Character, CharacterRelationship, Snapshot } from '@/types';
import { applyCharacterReconciliation, updateArcReferences } from '@/lib/reconcile';
import { renameCharacter, mergeCharacters, splitCharacter, deleteCharacter } from '@/lib/propagate-edit';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import EntityPicker from './EntityPicker';

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

/** Returns true if any name/alias/name-part of `c` appears as a whole word in `text` */
function mentionedIn(text: string, c: { name: string; aliases: string[] }): boolean {
  const allNames = [c.name, ...(c.aliases ?? [])];
  const candidates = new Set<string>(allNames);
  for (const fullName of allNames) {
    for (const word of fullName.split(/\s+/)) {
      if (word.length >= 3) candidates.add(word);
    }
  }
  return [...candidates].some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, 'i').test(text);
  });
}

interface TimelineEntry {
  chapterIndex: number;
  chapterTitle: string;
  recentEvents: string;
  location?: string;
  interactions: string[];
}

type EditMode = 'view' | 'edit' | 'merge' | 'split' | 'delete';

interface DraftCharacter {
  name: string;
  aliases: string;
  importance: Character['importance'];
  status: Character['status'];
  currentLocation: string;
  description: string;
  recentEvents: string;
  relationships: CharacterRelationship[];
}

function charToDraft(c: Character): DraftCharacter {
  return {
    name: c.name,
    aliases: (c.aliases ?? []).join(', '),
    importance: c.importance,
    status: c.status,
    currentLocation: c.currentLocation ?? '',
    description: c.description ?? '',
    recentEvents: c.recentEvents ?? '',
    relationships: [...(c.relationships ?? [])],
  };
}

function draftToChar(draft: DraftCharacter, original: Character): Character {
  return {
    ...original,
    name: draft.name.trim(),
    aliases: draft.aliases.split(',').map((s) => s.trim()).filter(Boolean),
    importance: draft.importance,
    status: draft.status,
    currentLocation: draft.currentLocation.trim() || 'Unknown',
    description: draft.description.trim(),
    recentEvents: draft.recentEvents.trim(),
    relationships: draft.relationships,
  };
}

interface Props {
  character: Character;
  snapshots?: Snapshot[];
  chapterTitles?: string[];
  currentResult?: AnalysisResult;
  onResultEdit?: (r: AnalysisResult, propagate?: SnapshotTransform) => void;
  onClose: () => void;
}

export default function CharacterModal({ character, snapshots, chapterTitles, currentResult, onResultEdit, onClose }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview');
  const [mode, setMode] = useState<EditMode>('view');
  const [draft, setDraft] = useState<DraftCharacter>(() => charToDraft(character));
  const [splitA, setSplitA] = useState<DraftCharacter>(() => charToDraft(character));
  const [splitB, setSplitB] = useState<DraftCharacter>(() => charToDraft(character));

  const canEdit = !!currentResult && !!onResultEdit;
  const status = STATUS_CONFIG[character.status] ?? STATUS_CONFIG.unknown;
  const importance = IMPORTANCE_CONFIG[character.importance] ?? IMPORTANCE_CONFIG.minor;

  // Build deduplicated event timeline from snapshots
  const timeline: TimelineEntry[] = (() => {
    if (!snapshots?.length) return [];
    const entries: TimelineEntry[] = [];
    let lastEvents = '';
    const sorted = [...snapshots].sort((a, b) => a.index - b.index);
    const charNameSet = new Set(
      [character.name, ...(character.aliases ?? [])].map((n) => n.toLowerCase().trim()).filter(Boolean),
    );
    const matchesCharacter = (c: { name: string; aliases?: string[] }) =>
      [c.name, ...(c.aliases ?? [])].some((n) => charNameSet.has(n.toLowerCase().trim()));

    for (const snap of sorted) {
      const ch = snap.result.characters.find(matchesCharacter);
      if (!ch?.recentEvents || ch.recentEvents === lastEvents) continue;
      lastEvents = ch.recentEvents;
      const interactions = snap.result.characters
        .filter((c) => !matchesCharacter(c) && mentionedIn(ch.recentEvents, c))
        .map((c) => c.name);
      entries.push({
        chapterIndex: snap.index,
        chapterTitle: chapterTitles?.[snap.index] ?? `Chapter ${snap.index + 1}`,
        recentEvents: ch.recentEvents,
        location: ch.currentLocation || undefined,
        interactions,
      });
    }
    return entries.reverse();
  })();

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { if (mode !== 'view') setMode('view'); else onClose(); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, mode]);

  // ── Save helpers ──

  function handleSaveEdit() {
    if (!currentResult || !onResultEdit) return;
    const updated = draftToChar(draft, character);
    const oldName = character.name;
    const newName = updated.name;
    const nameMap = new Map<string, string>();
    if (oldName !== newName) nameMap.set(oldName.toLowerCase(), newName);

    const characters = currentResult.characters.map((c) => {
      if (c.name === oldName) return updated;
      // Update relationships referencing old name
      if (nameMap.size > 0 && c.relationships?.length) {
        return {
          ...c,
          relationships: c.relationships.map((r) => ({
            ...r,
            character: nameMap.get(r.character.toLowerCase()) ?? r.character,
          })),
        };
      }
      return c;
    });
    const arcs = nameMap.size > 0 ? updateArcReferences(currentResult.arcs, nameMap) : currentResult.arcs;

    const propagate = oldName !== newName ? renameCharacter(oldName, newName) : undefined;
    onResultEdit({ ...currentResult, characters, arcs }, propagate);
    onClose();
  }

  function handleMerge(targetName: string) {
    if (!currentResult || !onResultEdit) return;
    const idxA = currentResult.characters.findIndex((c) => c.name === character.name);
    const idxB = currentResult.characters.findIndex((c) => c.name === targetName);
    if (idxA < 0 || idxB < 0) return;
    const charB = currentResult.characters[idxB];

    const mergeGroup = {
      primary: idxA,
      absorb: [idxB],
      reason: 'Manual merge',
      combinedAliases: [...(character.aliases ?? []), charB.name, ...(charB.aliases ?? [])],
    };
    const { characters, nameMap } = applyCharacterReconciliation(
      currentResult.characters, { mergeGroups: [mergeGroup], splits: [] },
    );
    const arcs = updateArcReferences(currentResult.arcs, nameMap);
    onResultEdit({ ...currentResult, characters, arcs }, mergeCharacters(character.name, targetName));
    onClose();
  }

  function handleSplit() {
    if (!currentResult || !onResultEdit) return;
    const idx = currentResult.characters.findIndex((c) => c.name === character.name);
    if (idx < 0) return;

    const split = {
      sourceIndex: idx,
      reason: 'Manual split',
      newEntries: [
        { name: splitA.name.trim(), aliases: splitA.aliases.split(',').map((s) => s.trim()).filter(Boolean), description: splitA.description.trim() },
        { name: splitB.name.trim(), aliases: splitB.aliases.split(',').map((s) => s.trim()).filter(Boolean), description: splitB.description.trim() },
      ],
    };
    const { characters } = applyCharacterReconciliation(
      currentResult.characters, { mergeGroups: [], splits: [split] },
    );
    onResultEdit({ ...currentResult, characters }, splitCharacter(character.name, splitA.name.trim(), splitB.name.trim()));
    onClose();
  }

  function handleDelete() {
    if (!currentResult || !onResultEdit) return;
    const name = character.name;
    const characters = currentResult.characters
      .filter((c) => c.name !== name)
      .map((c) => ({
        ...c,
        relationships: (c.relationships ?? []).filter((r) => r.character !== name),
      }));
    const arcs = (currentResult.arcs ?? []).map((a) => ({
      ...a,
      characters: a.characters.filter((n) => n !== name),
    }));
    onResultEdit({ ...currentResult, characters, arcs }, deleteCharacter(character.name));
    onClose();
  }

  // ── Render helpers ──

  function renderEditForm() {
    return (
      <div className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Name</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Aliases (comma-separated)</label>
          <input
            value={draft.aliases}
            onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
            className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Importance</label>
            <div className="flex gap-1 mt-1">
              {(['main', 'secondary', 'minor'] as const).map((val) => (
                <button
                  key={val}
                  onClick={() => setDraft({ ...draft, importance: val })}
                  className={`flex-1 text-xs py-1.5 rounded-lg border font-medium transition-colors ${
                    draft.importance === val
                      ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                      : 'border-stone-300 dark:border-zinc-700 text-stone-400 dark:text-zinc-500 hover:text-stone-600 dark:hover:text-zinc-300'
                  }`}
                >
                  {val.charAt(0).toUpperCase() + val.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1">
            <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Status</label>
            <div className="flex gap-1 mt-1">
              {(['alive', 'dead', 'unknown', 'uncertain'] as const).map((val) => (
                <button
                  key={val}
                  onClick={() => setDraft({ ...draft, status: val })}
                  className={`flex-1 text-[10px] py-1.5 rounded-lg border font-medium transition-colors ${
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
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Current Location</label>
          <input
            value={draft.currentLocation}
            onChange={(e) => setDraft({ ...draft, currentLocation: e.target.value })}
            className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Description</label>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={3}
            className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500 resize-none"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Recent Events</label>
          <textarea
            value={draft.recentEvents}
            onChange={(e) => setDraft({ ...draft, recentEvents: e.target.value })}
            rows={2}
            className="mt-1 w-full text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500 resize-none"
          />
        </div>
        {/* Relationships */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider">Relationships</label>
            <button
              onClick={() => setDraft({ ...draft, relationships: [...draft.relationships, { character: '', relationship: '' }] })}
              className="text-[10px] text-amber-500 hover:text-amber-400 font-medium"
            >
              + Add
            </button>
          </div>
          <div className="mt-1 space-y-1.5">
            {draft.relationships.map((rel, i) => (
              <div key={i} className="flex gap-1.5 items-center">
                <input
                  value={rel.character}
                  onChange={(e) => {
                    const rels = [...draft.relationships];
                    rels[i] = { ...rels[i], character: e.target.value };
                    setDraft({ ...draft, relationships: rels });
                  }}
                  placeholder="Character"
                  className="flex-1 text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500"
                />
                <input
                  value={rel.relationship}
                  onChange={(e) => {
                    const rels = [...draft.relationships];
                    rels[i] = { ...rels[i], relationship: e.target.value };
                    setDraft({ ...draft, relationships: rels });
                  }}
                  placeholder="Relationship"
                  className="flex-1 text-xs px-2 py-1 rounded-md border bg-transparent outline-none border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 focus:border-stone-400 dark:focus:border-zinc-500"
                />
                <button
                  onClick={() => setDraft({ ...draft, relationships: draft.relationships.filter((_, j) => j !== i) })}
                  className="text-stone-400 hover:text-red-400 text-xs flex-shrink-0"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
        {/* Action buttons */}
        <div className="flex gap-2 pt-2">
          <button onClick={handleSaveEdit} className="flex-1 text-xs py-2 rounded-lg bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 transition-colors">
            Save
          </button>
          <button onClick={() => { setDraft(charToDraft(character)); setMode('view'); }} className="flex-1 text-xs py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">
            Cancel
          </button>
        </div>
        {/* Merge / Split / Delete row */}
        <div className="flex gap-2 border-t border-stone-200 dark:border-zinc-800 pt-3">
          <button onClick={() => setMode('merge')} className="text-[11px] px-2.5 py-1 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-amber-500 hover:border-amber-500/40 transition-colors">
            Merge with...
          </button>
          <button onClick={() => { setSplitA(charToDraft(character)); setSplitB(charToDraft(character)); setMode('split'); }} className="text-[11px] px-2.5 py-1 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-violet-400 hover:border-violet-400/40 transition-colors">
            Split into two...
          </button>
          <button onClick={() => setMode('delete')} className="ml-auto text-[11px] px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">
            Delete
          </button>
        </div>
      </div>
    );
  }

  function renderSplitForm() {
    const renderHalf = (label: string, d: DraftCharacter, setD: (d: DraftCharacter) => void) => (
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
        <p className="text-xs text-stone-400 dark:text-zinc-500">Split <strong className="text-stone-700 dark:text-zinc-300">{character.name}</strong> into two separate characters. Edit each side, then confirm.</p>
        <div className="flex gap-3">
          {renderHalf('Character A', splitA, setSplitA)}
          <div className="w-px bg-stone-200 dark:bg-zinc-800 flex-shrink-0" />
          {renderHalf('Character B', splitB, setSplitB)}
        </div>
        <div className="flex gap-2">
          <button onClick={handleSplit} disabled={!canConfirm} className="flex-1 text-xs py-2 rounded-lg bg-violet-500 text-white font-semibold hover:bg-violet-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            Split
          </button>
          <button onClick={() => setMode('edit')} className="flex-1 text-xs py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderDeleteConfirm() {
    return (
      <div className="space-y-4 text-center py-4">
        <p className="text-sm text-stone-700 dark:text-zinc-300">
          Delete <strong>{character.name}</strong>? This cannot be undone.
        </p>
        <p className="text-xs text-stone-400 dark:text-zinc-500">
          References to this character will be removed from other characters&apos; relationships and arc character lists.
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={handleDelete} className="text-xs px-4 py-2 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-400 transition-colors">
            Confirm Delete
          </button>
          <button onClick={() => setMode('edit')} className="text-xs px-4 py-2 rounded-lg border border-stone-300 dark:border-zinc-700 text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-300 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {mode === 'merge' && currentResult && (
        <EntityPicker
          items={currentResult.characters
            .filter((c) => c.name !== character.name)
            .map((c) => ({ name: c.name, aliases: c.aliases, description: c.description }))}
          label={`Merge "${character.name}" with...`}
          onSelect={handleMerge}
          onClose={() => setMode('edit')}
        />
      )}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={mode === 'view' ? onClose : undefined}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={mode !== 'view' ? () => setMode('view') : undefined} />

        {/* Panel */}
        <div
          className="relative z-10 w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl border border-stone-200 dark:border-zinc-800 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="p-6 border-b border-stone-200 dark:border-zinc-800 pb-0">
            <div className="flex items-start gap-4">
              <div className={`flex-shrink-0 w-14 h-14 rounded-xl flex items-center justify-center text-lg font-bold ${nameColor(character.name)}`}>
                {initials(character.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-stone-900 dark:text-zinc-100 leading-tight">{character.name}</h2>
                    {character.aliases?.length > 0 && (
                      <p className="text-sm text-stone-400 dark:text-zinc-500 mt-0.5">{character.aliases.join(' · ')}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {canEdit && mode === 'view' && (
                      <button
                        onClick={() => { setDraft(charToDraft(character)); setMode('edit'); setTab('overview'); }}
                        className="flex-shrink-0 text-stone-400 dark:text-zinc-600 hover:text-amber-500 transition-colors text-sm leading-none p-1"
                        title="Edit character"
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
                    <span className={`text-xs px-2.5 py-1 rounded-md font-semibold ${importance.color}`}>
                      {importance.label}
                    </span>
                    <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border font-medium ${status.color}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                      {status.label}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Tabs — only show in view mode */}
            {mode === 'view' && (
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
                {character.description && (
                  <section>
                    <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-1.5">About</p>
                    <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{character.description}</p>
                  </section>
                )}
                <section className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-stone-100/50 dark:bg-zinc-800/50 rounded-lg border border-stone-200 dark:border-zinc-800">
                    <p className="text-[10px] font-semibold text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-1">Current location</p>
                    <p className="text-sm text-stone-700 dark:text-zinc-300">{character.currentLocation || 'Unknown'}</p>
                  </div>
                  <div className="p-3 bg-stone-100/50 dark:bg-zinc-800/50 rounded-lg border border-stone-200 dark:border-zinc-800">
                    <p className="text-[10px] font-semibold text-stone-400 dark:text-zinc-600 uppercase tracking-wider mb-1">Last seen</p>
                    <p className="text-sm text-stone-700 dark:text-zinc-300">{character.lastSeen || '—'}</p>
                  </div>
                </section>
                {character.recentEvents && (
                  <section>
                    <p className="text-xs font-semibold text-amber-500/80 uppercase tracking-wider mb-1.5">Recent events</p>
                    <div className="p-3 bg-amber-500/5 border border-amber-500/10 rounded-lg">
                      <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{character.recentEvents}</p>
                    </div>
                  </section>
                )}
                {character.relationships?.length > 0 && (
                  <section>
                    <p className="text-xs font-semibold text-stone-400 dark:text-zinc-500 uppercase tracking-wider mb-2">
                      Relationships ({character.relationships.length})
                    </p>
                    <ul className="space-y-2">
                      {character.relationships.map((rel, i) => (
                        <li key={i} className="flex items-start gap-3">
                          <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${nameColor(rel.character)}`}>
                            {initials(rel.character)}
                          </div>
                          <div className="flex-1 min-w-0 pt-0.5">
                            <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{rel.character}</span>
                            <span className="text-sm text-stone-400 dark:text-zinc-500"> — {rel.relationship}</span>
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
                  Event history · newest first
                </p>
                {timeline.length === 0 ? (
                  <p className="text-sm text-stone-400 dark:text-zinc-600 text-center py-6">No history yet — analyze more chapters to build a timeline.</p>
                ) : (
                  <ol className="relative border-l border-stone-200 dark:border-zinc-800 space-y-0">
                    {timeline.map((entry, i) => (
                      <li key={i} className="pl-5 pb-6 last:pb-0 relative">
                        <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-stone-200 dark:bg-zinc-700 border border-stone-300 dark:border-zinc-600" />
                        <p className="text-[11px] font-semibold text-stone-400 dark:text-zinc-500 mb-1">
                          Ch. {entry.chapterIndex + 1} — {entry.chapterTitle}
                        </p>
                        {entry.location && entry.location !== 'Unknown' && (
                          <p className="text-[11px] text-stone-400 dark:text-zinc-600 mb-1">📍 {entry.location}</p>
                        )}
                        {entry.interactions.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-2">
                            {entry.interactions.map((name) => (
                              <span key={name} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-medium ${nameColor(name)}`}>
                                <span className="opacity-60">{initials(name)}</span>
                                {name}
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed">{entry.recentEvents}</p>
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
