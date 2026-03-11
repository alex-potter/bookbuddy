'use client';

import { useState } from 'react';
import type { QueueJob } from '@/types';

interface Props {
  jobs: QueueJob[];
  onRemove: (id: string) => void;
  onCancelCurrent: () => void;
  onClearDone: () => void;
}

const STATUS_ICON: Record<QueueJob['status'], string> = {
  waiting: '·',
  running: '◌',
  done: '✓',
  error: '✗',
};

export default function ProcessingQueue({ jobs, onRemove, onCancelCurrent, onClearDone }: Props) {
  const [open, setOpen] = useState(true);

  if (jobs.length === 0) return null;

  const running = jobs.find((j) => j.status === 'running');
  const pending = jobs.filter((j) => j.status === 'waiting' || j.status === 'running');
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'error');

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-stone-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-stone-50 dark:bg-zinc-800/60 border-b border-stone-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          {running && <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />}
          <span className="text-xs font-semibold text-stone-700 dark:text-zinc-300">
            Queue{pending.length > 0 ? ` · ${pending.length} remaining` : ' · done'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {finished.length > 0 && (
            <button
              onClick={onClearDone}
              className="text-[10px] text-stone-400 dark:text-zinc-600 hover:text-stone-600 dark:hover:text-zinc-400 transition-colors"
            >
              Clear done
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-stone-400 dark:text-zinc-600 hover:text-stone-700 dark:hover:text-zinc-300 text-xs transition-colors w-4 text-center"
          >
            {open ? '▾' : '▸'}
          </button>
        </div>
      </div>

      {open && (
        <ul className="max-h-60 overflow-y-auto divide-y divide-stone-100 dark:divide-zinc-800/60">
          {jobs.map((job) => (
            <li key={job.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                <span
                  className={`flex-shrink-0 mt-0.5 text-sm leading-none ${
                    job.status === 'running' ? 'text-amber-500 animate-spin' :
                    job.status === 'done' ? 'text-emerald-400' :
                    job.status === 'error' ? 'text-red-400' :
                    'text-stone-400 dark:text-zinc-600'
                  }`}
                >
                  {STATUS_ICON[job.status]}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-stone-700 dark:text-zinc-300 truncate">{job.title}</p>
                  <p className="text-[10px] text-stone-400 dark:text-zinc-600 truncate">{job.author}</p>
                  {job.status === 'running' && job.progress && (
                    <>
                      <p className="text-[10px] text-stone-400 dark:text-zinc-500 mt-0.5 truncate">
                        Ch. {job.progress.current}/{job.progress.total}
                        {job.progress.chapterTitle && ` · ${job.progress.chapterTitle}`}
                      </p>
                      <div className="mt-1.5 w-full bg-stone-200 dark:bg-zinc-800 rounded-full h-0.5">
                        <div
                          className="h-0.5 bg-amber-500 rounded-full transition-all duration-300"
                          style={{ width: `${Math.round((job.progress.current / job.progress.total) * 100)}%` }}
                        />
                      </div>
                    </>
                  )}
                  {job.status === 'error' && job.error && (
                    <p className="text-[10px] text-red-400 mt-0.5 line-clamp-2">{job.error}</p>
                  )}
                </div>
                {job.status === 'running' ? (
                  <button
                    onClick={onCancelCurrent}
                    className="flex-shrink-0 text-[10px] text-stone-400 dark:text-zinc-600 hover:text-red-400 transition-colors mt-0.5"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={() => onRemove(job.id)}
                    className="flex-shrink-0 text-stone-300 dark:text-zinc-700 hover:text-red-400 transition-colors text-xs leading-none mt-0.5"
                  >
                    ✕
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
