'use client';

import { useRef, useState, useEffect } from 'react';

interface ExploreHeaderProps {
  bookTitle: string;
  currentChapterIndex: number;
  totalChapters: number;
  onChapterPillTap: () => void;
  onOpenWorkshop: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onChangeBook: () => void;
  onToggleTheme: () => void;
  isDark: boolean;
  hasStoredState: boolean;
}

export default function ExploreHeader({
  bookTitle,
  currentChapterIndex,
  totalChapters,
  onChapterPillTap,
  onOpenWorkshop,
  onOpenChat,
  onOpenSettings,
  onChangeBook,
  onToggleTheme,
  isDark,
  hasStoredState,
}: ExploreHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <header className="bg-paper-raised border-b border-border px-4 py-2 flex items-center justify-between gap-2 flex-shrink-0 lg:pl-20">
      <h1 className="font-serif italic text-ink text-sm truncate min-w-0 flex-1">
        {bookTitle}
      </h1>

      <button
        onClick={onChapterPillTap}
        className="flex-shrink-0 px-3 py-1 rounded-full bg-paper-dark text-ink-soft font-mono text-xs font-medium transition-colors hover:bg-border"
      >
        Ch {currentChapterIndex + 1}
        <span className="text-ink-dim">/{totalChapters}</span>
      </button>

      <div className="relative flex-shrink-0" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="w-8 h-8 flex items-center justify-center text-ink-soft hover:text-ink transition-colors rounded-lg"
          aria-label="More actions"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="2.5" r="1.5"/>
            <circle cx="8" cy="8" r="1.5"/>
            <circle cx="8" cy="13.5" r="1.5"/>
          </svg>
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 bg-paper-raised border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
            {hasStoredState && (
              <button
                onClick={() => { onOpenWorkshop(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper-dark transition-colors font-serif"
              >
                Workshop
              </button>
            )}
            {hasStoredState && (
              <button
                onClick={() => { onOpenChat(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper-dark transition-colors"
              >
                Chat
              </button>
            )}
            <button
              onClick={() => { onOpenSettings(); setMenuOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper-dark transition-colors"
            >
              Settings
            </button>
            <button
              onClick={() => { onToggleTheme(); setMenuOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper-dark transition-colors"
            >
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
            <button
              onClick={() => { onChangeBook(); setMenuOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-paper-dark transition-colors"
            >
              Change book
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
