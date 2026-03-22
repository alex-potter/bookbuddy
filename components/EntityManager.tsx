'use client';

import { useState, useRef, useEffect } from 'react';
import type { AnalysisResult, PinUpdates, Snapshot } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import { mergeCharacters, splitCharacter, deleteCharacter, mergeLocations, splitLocation, deleteLocation, mergeArcs, splitArc, deleteArc } from '@/lib/propagate-edit';
import { aggregateEntities } from '@/lib/aggregate-entities';
import type { AggregatedCharacter, AggregatedLocation, AggregatedArc } from '@/lib/aggregate-entities';
import type { ReconcileProposals, MergeProposal, SplitProposal } from '@/lib/reconcile';
import CharacterModal from './CharacterModal';
import LocationModal from './LocationModal';
import NarrativeArcModal from './NarrativeArcModal';
import EntityPicker from './EntityPicker';

const IS_MOBILE = process.env.NEXT_PUBLIC_MOBILE === 'true';

type EntityTab = 'characters' | 'locations' | 'arcs';

interface Props {
  snapshots: Snapshot[];
  currentResult: AnalysisResult;
  chapterTitles: string[];
  onResultEdit: (result: AnalysisResult, propagate?: SnapshotTransform, pinUpdates?: PinUpdates) => void;
  aggregated?: { characters: AggregatedCharacter[]; locations: AggregatedLocation[]; arcs: AggregatedArc[] };
  bookTitle: string;
  bookAuthor: string;
}

function chapterRange(first: number, last: number, titles: string[]): string {
  if (first < 0) return '';
  const f = first + 1;
  const l = last + 1;
  if (f === l) return `Ch. ${f}`;
  return `Ch. ${f}\u2013${l}`;
}

function composeTransforms(fns: SnapshotTransform[]): SnapshotTransform {
  return (r) => fns.reduce((acc, fn) => fn(acc), r);
}

const phaseLabels: Record<string, string> = {
  preparing: 'Preparing\u2026',
  calling_ai: 'Waiting for AI\u2026',
  parsing: 'Processing results\u2026',
};

export default function EntityManager({ snapshots, currentResult, chapterTitles, onResultEdit, aggregated: aggregatedProp, bookTitle, bookAuthor }: Props) {
  const [entityTab, setEntityTab] = useState<EntityTab>('characters');
  const [search, setSearch] = useState('');
  const [showHistorical, setShowHistorical] = useState(true);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [expandedHistorical, setExpandedHistorical] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<{ name: string; type: EntityTab } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMergeOpen, setBatchMergeOpen] = useState(false);

  // AI proposal review state
  const [proposals, setProposals] = useState<ReconcileProposals | null>(null);
  const [proposalStatus, setProposalStatus] = useState<'idle' | 'loading' | 'reviewing' | 'error'>('idle');
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());

  // AI progress tracking
  const [evalProgress, setEvalProgress] = useState<{
    phase: string; entityCount?: number; entityType?: string;
    startTime: number; elapsed: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const aggregated = aggregatedProp ?? aggregateEntities(snapshots, currentResult);

  const q = search.toLowerCase().trim();

  function matchesSearch(name: string, aliases?: string[]): boolean {
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;
    return (aliases ?? []).some((a) => a.toLowerCase().includes(q));
  }

  // Filter helpers
  const filteredChars = aggregated.characters.filter((e) => {
    if (!showHistorical && !e.isCurrent) return false;
    return matchesSearch(e.character.name, e.character.aliases);
  });
  const filteredLocs = aggregated.locations.filter((e) => {
    if (!showHistorical && !e.isCurrent) return false;
    return matchesSearch(e.location.name, e.location.aliases);
  });
  const filteredArcs = aggregated.arcs.filter((e) => {
    if (!showHistorical && !e.isCurrent) return false;
    return matchesSearch(e.arc.name);
  });

  // Counts
  const counts = {
    characters: { total: filteredChars.length, current: filteredChars.filter((e) => e.isCurrent).length },
    locations: { total: filteredLocs.length, current: filteredLocs.filter((e) => e.isCurrent).length },
    arcs: { total: filteredArcs.length, current: filteredArcs.filter((e) => e.isCurrent).length },
  };
  const c = counts[entityTab];

  function handleHistoricalMerge(name: string, targetName: string) {
    let transform: SnapshotTransform;
    if (entityTab === 'characters') {
      transform = mergeCharacters(targetName, name);
    } else if (entityTab === 'locations') {
      transform = mergeLocations(targetName, name);
    } else {
      transform = mergeArcs(targetName, name);
    }
    const pins: PinUpdates | undefined = entityTab === 'locations' ? { renames: { [name]: targetName } } : undefined;
    onResultEdit(transform(currentResult), transform, pins);
    setExpandedHistorical(null);
    setMergeTarget(null);
  }

  function handleHistoricalDelete(name: string) {
    if (!confirm(`Delete "${name}" from all snapshots?`)) return;
    let transform: SnapshotTransform;
    if (entityTab === 'characters') {
      transform = deleteCharacter(name);
    } else if (entityTab === 'locations') {
      transform = deleteLocation(name);
    } else {
      transform = deleteArc(name);
    }
    const pins: PinUpdates | undefined = entityTab === 'locations' ? { deletes: [name] } : undefined;
    onResultEdit(transform(currentResult), transform, pins);
    setExpandedHistorical(null);
  }

  function toggleSelect(name: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function handleBatchMerge(targetName: string) {
    const transforms = [...selected].map(name => {
      if (entityTab === 'characters') return mergeCharacters(targetName, name);
      if (entityTab === 'locations') return mergeLocations(targetName, name);
      return mergeArcs(targetName, name);
    });
    const composed = composeTransforms(transforms);
    const pins: PinUpdates | undefined = entityTab === 'locations'
      ? { renames: Object.fromEntries([...selected].map(name => [name, targetName])) }
      : undefined;
    onResultEdit(composed(currentResult), composed, pins);
    setSelected(new Set());
    setBatchMergeOpen(false);
  }

  function handleBatchDelete() {
    if (!confirm(`Delete ${selected.size} ${entityTab}?`)) return;
    const transforms = [...selected].map(name => {
      if (entityTab === 'characters') return deleteCharacter(name);
      if (entityTab === 'locations') return deleteLocation(name);
      return deleteArc(name);
    });
    const composed = composeTransforms(transforms);
    const pins: PinUpdates | undefined = entityTab === 'locations' ? { deletes: [...selected] } : undefined;
    onResultEdit(composed(currentResult), composed, pins);
    setSelected(new Set());
  }

  // ── AI Evaluate ──────────────────────────────────────────────────────────
  async function evaluateEntities(type: EntityTab) {
    const ac = new AbortController();
    abortRef.current = ac;
    setProposalStatus('loading');
    setProposalError(null);
    const startTime = Date.now();
    setEvalProgress({ phase: 'preparing', startTime, elapsed: 0 });
    timerRef.current = setInterval(() => {
      setEvalProgress((prev) => prev ? { ...prev, elapsed: Math.floor((Date.now() - prev.startTime) / 1000) } : null);
    }, 1000);

    try {
      if (IS_MOBILE) {
        setEvalProgress((prev) => prev ? { ...prev, phase: 'calling_ai' } : null);
        const { reconcileProposeClient } = await import('@/lib/ai-client');
        const proposals = await reconcileProposeClient(
          type, currentResult, bookTitle, bookAuthor,
          currentResult.summary ?? undefined,
        );
        setProposals(proposals);
        setAcceptedIds(new Set());
        setRejectedIds(new Set());
        setProposalStatus('reviewing');
        return;
      }

      let aiSettings: Record<string, string> = {};
      try {
        const { loadAiSettings } = await import('@/lib/ai-client');
        const s = loadAiSettings();
        if (s.provider) aiSettings._provider = s.provider;
        if (s.anthropicKey) aiSettings._apiKey = s.anthropicKey;
        if (s.ollamaUrl) aiSettings._ollamaUrl = s.ollamaUrl;
        if (s.model) aiSettings._model = s.model;
      } catch { /* server will use env vars */ }

      const res = await fetch('/api/reconcile-propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: type, result: currentResult, bookTitle, bookAuthor,
          chapterExcerpts: currentResult.summary ?? undefined,
          ...aiSettings,
        }),
        signal: ac.signal,
      });

      const contentType = res.headers.get('Content-Type') ?? '';

      if (contentType.includes('application/json')) {
        // Non-streaming response (early return or pre-stream error)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error ?? 'Evaluation failed.');
        }
        const data = (await res.json()) as ReconcileProposals;
        setProposals(data);
        setAcceptedIds(new Set());
        setRejectedIds(new Set());
        setProposalStatus('reviewing');
        return;
      }

      // NDJSON streaming response
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          if (event.phase === 'preparing' || event.phase === 'calling_ai' || event.phase === 'parsing') {
            setEvalProgress((prev) => prev ? {
              ...prev,
              phase: event.phase,
              ...(event.entityCount != null ? { entityCount: event.entityCount } : {}),
              ...(event.entityType ? { entityType: event.entityType } : {}),
            } : null);
          } else if (event.phase === 'done') {
            setProposals(event.proposals);
            setAcceptedIds(new Set());
            setRejectedIds(new Set());
            setProposalStatus('reviewing');
          } else if (event.phase === 'error') {
            throw new Error(event.message ?? 'Evaluation failed.');
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setProposalStatus('idle');
      } else {
        setProposalError(err instanceof Error ? err.message : 'Unknown error');
        setProposalStatus('error');
      }
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      abortRef.current = null;
      setEvalProgress(null);
    }
  }

  function clearProposals() {
    abortRef.current?.abort();
    setProposals(null);
    setProposalStatus('idle');
    setProposalError(null);
    setAcceptedIds(new Set());
    setRejectedIds(new Set());
  }

  function cancelEvaluate() {
    abortRef.current?.abort();
  }

  function toggleAccept(id: string) {
    setAcceptedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setRejectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  function toggleReject(id: string) {
    setRejectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAcceptedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  function acceptAll() {
    if (!proposals) return;
    const all = new Set([...proposals.merges.map((m) => m.id), ...proposals.splits.map((s) => s.id)]);
    setAcceptedIds(all);
    setRejectedIds(new Set());
  }

  function rejectAll() {
    if (!proposals) return;
    const all = new Set([...proposals.merges.map((m) => m.id), ...proposals.splits.map((s) => s.id)]);
    setRejectedIds(all);
    setAcceptedIds(new Set());
  }

  function applyAccepted() {
    if (!proposals) return;

    const acceptedMerges = proposals.merges.filter((m) => acceptedIds.has(m.id));
    const acceptedSplits = proposals.splits.filter((s) => acceptedIds.has(s.id));
    if (acceptedMerges.length === 0 && acceptedSplits.length === 0) return;

    const transforms: SnapshotTransform[] = [];
    const type = proposals.entityType;

    // Splits first (so split entities exist before merges reference them)
    for (const sp of acceptedSplits) {
      if (type === 'characters') transforms.push(splitCharacter(sp.sourceName, sp.newNames[0], sp.newNames[1]));
      else if (type === 'locations') transforms.push(splitLocation(sp.sourceName, sp.newNames[0], sp.newNames[1]));
      else transforms.push(splitArc(sp.sourceName, sp.newNames[0], sp.newNames[1]));
    }

    // Then merges (one transform per absorbed name)
    for (const mg of acceptedMerges) {
      for (const absorbed of mg.absorbedNames) {
        if (type === 'characters') transforms.push(mergeCharacters(mg.primaryName, absorbed));
        else if (type === 'locations') transforms.push(mergeLocations(mg.primaryName, absorbed));
        else transforms.push(mergeArcs(mg.primaryName, absorbed));
      }
    }

    const composed = composeTransforms(transforms);
    let patchedResult = composed(currentResult);

    // Enrich split entries with LLM-suggested descriptions/aliases/summaries
    for (const sp of acceptedSplits) {
      for (const entry of sp.newEntries) {
        if (type === 'characters') {
          patchedResult = {
            ...patchedResult,
            characters: patchedResult.characters.map((c) =>
              c.name === entry.name ? {
                ...c,
                ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
                ...(entry.description ? { description: entry.description } : {}),
              } : c,
            ),
          };
        } else if (type === 'locations') {
          patchedResult = {
            ...patchedResult,
            locations: patchedResult.locations?.map((l) =>
              l.name === entry.name ? {
                ...l,
                ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
                ...(entry.description ? { description: entry.description } : {}),
              } : l,
            ),
          };
        } else {
          patchedResult = {
            ...patchedResult,
            arcs: patchedResult.arcs?.map((a) =>
              a.name === entry.name ? {
                ...a,
                ...(entry.summary ? { summary: entry.summary } : {}),
              } : a,
            ),
          };
        }
      }
    }

    // Enrich merged entities with LLM-suggested combinedAliases
    for (const mg of acceptedMerges) {
      if (!mg.combinedAliases.length) continue;
      if (type === 'characters') {
        patchedResult = {
          ...patchedResult,
          characters: patchedResult.characters.map((c) =>
            c.name === mg.primaryName ? {
              ...c,
              aliases: [...new Set([
                ...c.aliases,
                ...mg.combinedAliases,
              ].map(s => s.trim()).filter(s => s && s.toLowerCase() !== c.name.toLowerCase()))],
            } : c,
          ),
        };
      } else if (type === 'locations') {
        patchedResult = {
          ...patchedResult,
          locations: patchedResult.locations?.map((l) =>
            l.name === mg.primaryName ? {
              ...l,
              aliases: (() => {
                const all = new Set([
                  ...(l.aliases ?? []),
                  ...mg.combinedAliases,
                ].map(s => s.trim()).filter(s => s && s.toLowerCase() !== l.name.toLowerCase()));
                return all.size > 0 ? [...all] : undefined;
              })(),
            } : l,
          ),
        };
      }
      // Arcs have no aliases — nothing to patch
    }

    // Build pin updates for location merges
    const pinUpdates: PinUpdates | undefined = type === 'locations' && acceptedMerges.length > 0
      ? { renames: Object.fromEntries(acceptedMerges.flatMap((m) => m.absorbedNames.map((n) => [n, m.primaryName]))) }
      : undefined;

    onResultEdit(patchedResult, composed, pinUpdates);
    clearProposals();
  }

  const acceptedCount = acceptedIds.size;

  // Current entities for merge picker
  const currentPickerItems = entityTab === 'characters'
    ? currentResult.characters.map((c) => ({ name: c.name, aliases: c.aliases, description: c.description }))
    : entityTab === 'locations'
      ? (currentResult.locations ?? []).map((l) => ({ name: l.name, aliases: l.aliases, description: l.description }))
      : (currentResult.arcs ?? []).map((a) => ({ name: a.name, description: a.summary }));

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex items-center gap-1.5">
        {(['characters', 'locations', 'arcs'] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setEntityTab(t); setExpandedHistorical(null); setSelected(new Set()); setBatchMergeOpen(false); clearProposals(); }}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              entityTab === t
                ? 'bg-stone-200 dark:bg-zinc-700 text-stone-900 dark:text-zinc-100'
                : 'text-stone-400 dark:text-zinc-500 hover:text-stone-600 dark:hover:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-800'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
            <span className="ml-1 text-[10px] opacity-60">{counts[t].total}</span>
          </button>
        ))}
      </div>

      {/* AI Evaluate button + progress */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => evaluateEntities(entityTab)}
          disabled={proposalStatus === 'loading' || proposalStatus === 'reviewing'}
          className="text-xs px-3 py-1.5 rounded-lg border transition-colors flex items-center gap-1.5 border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {proposalStatus === 'loading' && (
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
          )}
          AI Evaluate
        </button>
        {proposalStatus === 'loading' && evalProgress && (
          <span className="text-xs text-stone-500 dark:text-zinc-400 flex items-center gap-2">
            {evalProgress.entityCount != null && (
              <span>Evaluating {evalProgress.entityCount} {evalProgress.entityType}</span>
            )}
            <span className="text-stone-400 dark:text-zinc-500">{phaseLabels[evalProgress.phase] ?? evalProgress.phase}</span>
            <span className="tabular-nums text-stone-400 dark:text-zinc-500">{evalProgress.elapsed}s</span>
            <button
              onClick={cancelEvaluate}
              className="text-xs px-1.5 py-0.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
            >Cancel</button>
          </span>
        )}
        {proposalStatus === 'error' && proposalError && (
          <span className="text-xs text-red-500 truncate max-w-[300px]">{proposalError}</span>
        )}
      </div>

      {/* Proposal review panel */}
      {proposalStatus === 'reviewing' && proposals && (() => {
        const allItems: Array<{ type: 'merge'; item: MergeProposal } | { type: 'split'; item: SplitProposal }> = [
          ...proposals.merges.map((m) => ({ type: 'merge' as const, item: m })),
          ...proposals.splits.map((s) => ({ type: 'split' as const, item: s })),
        ];
        const isEmpty = allItems.length === 0;

        if (isEmpty) {
          return (
            <div className="p-6 text-center border border-stone-200 dark:border-zinc-800 rounded-lg">
              <p className="text-sm text-stone-500 dark:text-zinc-400 mb-3">No suggestions — entities look clean.</p>
              <button onClick={clearProposals} className="text-xs px-3 py-1.5 rounded-md bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-400 hover:bg-stone-200 dark:hover:bg-zinc-700 transition-colors">Close</button>
            </div>
          );
        }

        return (
          <div className="border border-stone-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-stone-50 dark:bg-zinc-900 border-b border-stone-200 dark:border-zinc-800">
              <span className="text-xs font-medium text-stone-600 dark:text-zinc-400">
                AI Proposals · {proposals.merges.length} merge{proposals.merges.length !== 1 ? 's' : ''}, {proposals.splits.length} split{proposals.splits.length !== 1 ? 's' : ''}
              </span>
              <div className="flex items-center gap-1.5">
                <button onClick={acceptAll} className="text-[10px] px-2 py-0.5 rounded text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors">Accept All</button>
                <button onClick={rejectAll} className="text-[10px] px-2 py-0.5 rounded text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors">Reject All</button>
              </div>
            </div>

            {/* Cards */}
            <div className="divide-y divide-stone-100 dark:divide-zinc-800 max-h-[420px] overflow-y-auto">
              {allItems.map(({ type, item }) => {
                const isAccepted = acceptedIds.has(item.id);
                const isRejected = rejectedIds.has(item.id);
                const borderColor = isAccepted ? 'border-l-emerald-500' : isRejected ? 'border-l-red-400' : 'border-l-transparent';
                return (
                  <div key={item.id} className={`flex items-start gap-3 px-3 py-2.5 border-l-[3px] ${borderColor}`}>
                    <div className="flex-1 min-w-0">
                      {type === 'merge' ? (
                        <>
                          <p className="text-xs font-medium text-stone-700 dark:text-zinc-300">
                            Merge {(item as MergeProposal).absorbedNames.map((n) => `"${n}"`).join(', ')} → "{(item as MergeProposal).primaryName}"
                          </p>
                          <p className="text-[11px] text-stone-400 dark:text-zinc-500 mt-0.5">{(item as MergeProposal).reason}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-xs font-medium text-stone-700 dark:text-zinc-300">
                            Split "{(item as SplitProposal).sourceName}" → "{(item as SplitProposal).newNames[0]}" + "{(item as SplitProposal).newNames[1]}"
                          </p>
                          <p className="text-[11px] text-stone-400 dark:text-zinc-500 mt-0.5">{(item as SplitProposal).reason}</p>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => toggleAccept(item.id)}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${isAccepted ? 'bg-emerald-500 text-white' : 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30'}`}
                      >Accept</button>
                      <button
                        onClick={() => toggleReject(item.id)}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${isRejected ? 'bg-red-500 text-white' : 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'}`}
                      >Reject</button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Bottom bar */}
            <div className="flex items-center justify-end gap-2 px-3 py-2 bg-stone-50 dark:bg-zinc-900 border-t border-stone-200 dark:border-zinc-800">
              <button onClick={clearProposals} className="text-xs px-3 py-1.5 rounded-md text-stone-500 dark:text-zinc-500 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors">Cancel</button>
              <button
                onClick={applyAccepted}
                disabled={acceptedCount === 0}
                className="text-xs px-3 py-1.5 rounded-md bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >Apply {acceptedCount} accepted</button>
            </div>
          </div>
        );
      })()}

      {/* Search + historical toggle */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 text-sm px-3 py-1.5 rounded-lg border bg-transparent outline-none transition-colors border-stone-300 dark:border-zinc-700 text-stone-700 dark:text-zinc-300 placeholder-stone-400 dark:placeholder-zinc-600 focus:border-stone-400 dark:focus:border-zinc-500"
        />
        <label className="flex items-center gap-1.5 text-xs text-stone-400 dark:text-zinc-500 whitespace-nowrap cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showHistorical}
            onChange={(e) => setShowHistorical(e.target.checked)}
            className="rounded border-stone-300 dark:border-zinc-600"
          />
          Include historical
        </label>
      </div>

      {/* Stats line */}
      <p className="text-xs text-stone-400 dark:text-zinc-500">
        {c.total} {entityTab} ({c.current} current{c.total - c.current > 0 ? `, ${c.total - c.current} historical-only` : ''})
      </p>

      {/* Entity list */}
      <div className="space-y-1">
        {entityTab === 'characters' && filteredChars.map((entry) => (
          <CharacterRow
            key={entry.character.name}
            entry={entry}
            chapterTitles={chapterTitles}
            isExpanded={expandedHistorical === entry.character.name}
            isSelected={selected.has(entry.character.name)}
            onToggleSelect={() => toggleSelect(entry.character.name)}
            onClickCurrent={() => setSelectedEntity(entry.character.name)}
            onClickHistorical={() => setExpandedHistorical(expandedHistorical === entry.character.name ? null : entry.character.name)}
            onMerge={() => setMergeTarget({ name: entry.character.name, type: 'characters' })}
            onDelete={() => handleHistoricalDelete(entry.character.name)}
          />
        ))}
        {entityTab === 'locations' && filteredLocs.map((entry) => (
          <LocationRow
            key={entry.location.name}
            entry={entry}
            chapterTitles={chapterTitles}
            isExpanded={expandedHistorical === entry.location.name}
            isSelected={selected.has(entry.location.name)}
            onToggleSelect={() => toggleSelect(entry.location.name)}
            onClickCurrent={() => setSelectedEntity(entry.location.name)}
            onClickHistorical={() => setExpandedHistorical(expandedHistorical === entry.location.name ? null : entry.location.name)}
            onMerge={() => setMergeTarget({ name: entry.location.name, type: 'locations' })}
            onDelete={() => handleHistoricalDelete(entry.location.name)}
          />
        ))}
        {entityTab === 'arcs' && filteredArcs.map((entry) => (
          <ArcRow
            key={entry.arc.name}
            entry={entry}
            chapterTitles={chapterTitles}
            isExpanded={expandedHistorical === entry.arc.name}
            isSelected={selected.has(entry.arc.name)}
            onToggleSelect={() => toggleSelect(entry.arc.name)}
            onClickCurrent={() => setSelectedEntity(entry.arc.name)}
            onClickHistorical={() => setExpandedHistorical(expandedHistorical === entry.arc.name ? null : entry.arc.name)}
            onMerge={() => setMergeTarget({ name: entry.arc.name, type: 'arcs' })}
            onDelete={() => handleHistoricalDelete(entry.arc.name)}
          />
        ))}
      </div>

      {/* Floating action bar */}
      {selected.size > 0 && (
        <div className="sticky bottom-0 flex items-center gap-3 px-3 py-2.5 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-sm border border-stone-200 dark:border-zinc-800 rounded-lg">
          <span className="text-xs font-medium text-stone-600 dark:text-zinc-400">{selected.size} selected</span>
          <button
            onClick={() => setBatchMergeOpen(true)}
            className="text-xs px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
          >
            Merge into…
          </button>
          <button
            onClick={handleBatchDelete}
            className="text-xs px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs px-2.5 py-1 rounded-md text-stone-400 dark:text-zinc-500 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Current entity modals */}
      {selectedEntity && entityTab === 'characters' && (() => {
        const char = currentResult.characters.find((c) => c.name === selectedEntity);
        if (!char) return null;
        return (
          <CharacterModal
            character={char}
            snapshots={snapshots}
            chapterTitles={chapterTitles}
            currentResult={currentResult}
            onResultEdit={onResultEdit}
            onClose={() => setSelectedEntity(null)}
          />
        );
      })()}
      {selectedEntity && entityTab === 'locations' && (
        <LocationModal
          locationName={selectedEntity}
          snapshots={snapshots}
          chapterTitles={chapterTitles}
          currentResult={currentResult}
          onResultEdit={onResultEdit}
          onClose={() => setSelectedEntity(null)}
        />
      )}
      {selectedEntity && entityTab === 'arcs' && (
        <NarrativeArcModal
          arcName={selectedEntity}
          snapshots={snapshots}
          chapterTitles={chapterTitles}
          currentResult={currentResult}
          onResultEdit={onResultEdit}
          onClose={() => setSelectedEntity(null)}
        />
      )}

      {/* Merge picker for historical entities */}
      {mergeTarget && (
        <EntityPicker
          items={currentPickerItems.filter((i) => i.name !== mergeTarget.name)}
          label={`Merge "${mergeTarget.name}" into...`}
          onSelect={(targetName) => handleHistoricalMerge(mergeTarget.name, targetName)}
          onClose={() => setMergeTarget(null)}
        />
      )}

      {/* Batch merge picker */}
      {batchMergeOpen && (
        <EntityPicker
          items={currentPickerItems.filter((i) => !selected.has(i.name))}
          label={`Merge ${selected.size} ${entityTab} into\u2026`}
          onSelect={handleBatchMerge}
          onClose={() => setBatchMergeOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Row sub-components ─────────────────────────────────────────────────── */

interface RowProps {
  chapterTitles: string[];
  isExpanded: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onClickCurrent: () => void;
  onClickHistorical: () => void;
  onMerge: () => void;
  onDelete: () => void;
}

function Badge({ isCurrent, first, last, titles }: { isCurrent: boolean; first: number; last: number; titles: string[] }) {
  const range = chapterRange(first, last, titles);
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${
      isCurrent
        ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
        : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
    }`}>
      {isCurrent ? 'current' : 'historical'}
      {range && <span className="opacity-70">{range}</span>}
    </span>
  );
}

function HistoricalActions({ isExpanded, onMerge, onDelete }: { isExpanded: boolean; onMerge: () => void; onDelete: () => void }) {
  if (!isExpanded) return null;
  return (
    <div className="flex items-center gap-2 pl-4 py-1.5">
      <button
        onClick={(e) => { e.stopPropagation(); onMerge(); }}
        className="text-xs px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
      >
        Merge into...
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="text-xs px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
      >
        Delete from all snapshots
      </button>
    </div>
  );
}

function CharacterRow({ entry, chapterTitles, isExpanded, isSelected, onToggleSelect, onClickCurrent, onClickHistorical, onMerge, onDelete }: RowProps & { entry: AggregatedCharacter }) {
  const { character: c, isCurrent, firstSeenIndex, lastSeenIndex } = entry;
  return (
    <div>
      <button
        onClick={isCurrent ? onClickCurrent : onClickHistorical}
        className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800/60 transition-colors flex items-center gap-3"
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-stone-300 dark:border-zinc-600 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{c.name}</span>
          {c.aliases.length > 0 && (
            <span className="ml-1.5 text-[11px] text-stone-400 dark:text-zinc-500">{c.aliases.join(', ')}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] text-stone-400 dark:text-zinc-500 capitalize">{c.importance}</span>
          <span className={`text-[10px] capitalize ${c.status === 'alive' ? 'text-emerald-500' : c.status === 'dead' ? 'text-red-400' : 'text-stone-400 dark:text-zinc-500'}`}>{c.status}</span>
          <Badge isCurrent={isCurrent} first={firstSeenIndex} last={lastSeenIndex} titles={chapterTitles} />
        </div>
      </button>
      {!isCurrent && <HistoricalActions isExpanded={isExpanded} onMerge={onMerge} onDelete={onDelete} />}
    </div>
  );
}

function LocationRow({ entry, chapterTitles, isExpanded, isSelected, onToggleSelect, onClickCurrent, onClickHistorical, onMerge, onDelete }: RowProps & { entry: AggregatedLocation }) {
  const { location: l, isCurrent, firstSeenIndex, lastSeenIndex } = entry;
  return (
    <div>
      <button
        onClick={isCurrent ? onClickCurrent : onClickHistorical}
        className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800/60 transition-colors flex items-center gap-3"
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-stone-300 dark:border-zinc-600 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{l.name}</span>
          {(l.aliases?.length ?? 0) > 0 && (
            <span className="ml-1.5 text-[11px] text-stone-400 dark:text-zinc-500">{l.aliases!.join(', ')}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {l.arc && <span className="text-[10px] text-stone-400 dark:text-zinc-500">{l.arc}</span>}
          <Badge isCurrent={isCurrent} first={firstSeenIndex} last={lastSeenIndex} titles={chapterTitles} />
        </div>
      </button>
      {!isCurrent && <HistoricalActions isExpanded={isExpanded} onMerge={onMerge} onDelete={onDelete} />}
    </div>
  );
}

function ArcRow({ entry, chapterTitles, isExpanded, isSelected, onToggleSelect, onClickCurrent, onClickHistorical, onMerge, onDelete }: RowProps & { entry: AggregatedArc }) {
  const { arc: a, isCurrent, firstSeenIndex, lastSeenIndex } = entry;
  const statusColor = a.status === 'active' ? 'text-amber-400' : a.status === 'resolved' ? 'text-emerald-400' : 'text-stone-400 dark:text-zinc-500';
  return (
    <div>
      <button
        onClick={isCurrent ? onClickCurrent : onClickHistorical}
        className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone-100 dark:hover:bg-zinc-800/60 transition-colors flex items-center gap-3"
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-stone-300 dark:border-zinc-600 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-stone-800 dark:text-zinc-200">{a.name}</span>
          {a.characters.length > 0 && (
            <span className="ml-1.5 text-[11px] text-stone-400 dark:text-zinc-500">{a.characters.join(', ')}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-[10px] capitalize ${statusColor}`}>{a.status}</span>
          <Badge isCurrent={isCurrent} first={firstSeenIndex} last={lastSeenIndex} titles={chapterTitles} />
        </div>
      </button>
      {!isCurrent && <HistoricalActions isExpanded={isExpanded} onMerge={onMerge} onDelete={onDelete} />}
    </div>
  );
}
