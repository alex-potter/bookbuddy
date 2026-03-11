'use client';

import { useCallback, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
  parsing: boolean;
}

export default function UploadZone({ onFile, parsing }: Props) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith('.epub')) onFile(file);
    },
    [onFile],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8 px-4">
      <div className="text-center">
        <h1 className="text-3xl sm:text-4xl font-bold text-stone-900 dark:text-zinc-100 tracking-tight mb-2">Chapter Companion</h1>
        <p className="text-stone-400 dark:text-zinc-500">Track characters as you read — spoiler-free</p>
      </div>

      <label
        htmlFor="epub-upload"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`
          relative flex flex-col items-center justify-center w-full max-w-sm h-52 rounded-2xl border-2 border-dashed
          cursor-pointer transition-all duration-200
          ${dragging
            ? 'border-amber-500 bg-amber-500/5'
            : 'border-stone-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-stone-400 dark:hover:border-zinc-500 active:bg-stone-100/60 dark:active:bg-zinc-800/60'
          }
          ${parsing ? 'pointer-events-none opacity-50' : ''}
        `}
      >
        {parsing ? (
          <>
            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-stone-500 dark:text-zinc-400 text-sm font-medium">Parsing EPUB…</p>
          </>
        ) : (
          <>
            <span className="text-4xl mb-3">📖</span>
            <p className="text-stone-700 dark:text-zinc-300 font-semibold text-center px-4">Tap to open EPUB</p>
            <p className="text-stone-400 dark:text-zinc-600 text-sm mt-1 hidden sm:block">or drop a file here</p>
          </>
        )}
        <input
          id="epub-upload"
          type="file"
          accept=".epub,.etbook"
          className="sr-only"
          onChange={handleChange}
          disabled={parsing}
        />
      </label>

      <div className="text-center text-sm text-stone-400 dark:text-zinc-600 max-w-xs">
        <p>Your book is processed entirely in your browser.</p>
        <p className="mt-1">Only the text <em className="text-stone-400 dark:text-zinc-500">you&apos;ve already read</em> is sent to the model — no spoilers, ever.</p>
      </div>
    </div>
  );
}
