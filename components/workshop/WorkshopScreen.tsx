'use client';

import { useState } from 'react';
import type { AnalysisResult, EbookChapter, ParsedEbook, QueueJob, Snapshot, StoredBookState, BookContainer, BookFilter } from '@/types';
import type { SnapshotTransform } from '@/lib/propagate-edit';
import ChapterSelector from '@/components/ChapterSelector';
import EntityManager from '@/components/EntityManager';
import SettingsModal from '@/components/SettingsModal';
import BookStructureEditor from '@/components/BookStructureEditor';
import BookCoverGradient from '@/components/ui/BookCoverGradient';
import type { DerivedEntities } from '@/lib/use-derived-entities';

type WorkshopTab = 'chapters' | 'structure' | 'entities' | 'library' | 'settings';

interface WorkshopScreenProps {
  book: ParsedEbook;
  stored: StoredBookState;
  result: AnalysisResult | null;
  currentIndex: number;
  onClose: () => void;

  // Chapter tab
  onChapterChange: (index: number) => void;
  onAnalyze: () => void;
  onCancelAnalyze: () => void;
  onRebuild: () => void;
  onCancelRebuild: () => void;
  onProcessBook: () => void;
  onDeleteSnapshot: (index: number) => void;
  onSetBookmark: (index: number | null) => void;
  onSetRange: (range: { start: number; end: number } | null) => void;
  analyzing: boolean;
  rebuilding: boolean;
  rebuildProgress: { current: number; total: number; chapterTitle?: string; chapterIndex?: number } | null;
  chapterRange: { start: number; end: number } | null;
  snapshotIndices: Set<number>;
  visibleChapterOrders: Set<number> | null;
  isMetaOnly: boolean;
  needsSetup: boolean;
  onCompleteSetup: (range: { start: number; end: number }) => void;

  // Entity tab
  derived: DerivedEntities;
  onResultEdit: (result: AnalysisResult, propagate?: SnapshotTransform) => void;
  currentChapterIndex: number;

  // Structure tab
  onSaveContainer: (container: BookContainer) => void;
  onReextractTitles: (chapterOrders: number[]) => Promise<Map<number, { title: string; preview?: string }>>;

  // Library tab
  savedBooks: Array<{ title: string; author: string; lastAnalyzedIndex: number; chapterCount?: number }>;
  onLoadBook: (title: string, author: string) => void;
  onDeleteBook: (title: string, author: string) => void;
  onImportFile: (file: File) => void;

  // Queue
  queue: QueueJob[];
  onRemoveJob: (id: string) => void;
  onCancelCurrentJob: () => void;
  onClearDone: () => void;
}

const TABS: { key: WorkshopTab; label: string }[] = [
  { key: 'chapters', label: 'Chapters' },
  { key: 'structure', label: 'Structure' },
  { key: 'entities', label: 'Entities' },
  { key: 'library', label: 'Library' },
  { key: 'settings', label: 'Settings' },
];

export default function WorkshopScreen(props: WorkshopScreenProps) {
  const [activeTab, setActiveTab] = useState<WorkshopTab>('chapters');
  const [showSettings, setShowSettings] = useState(false);
  const [showStructureEditor, setShowStructureEditor] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-paper flex flex-col animate-slide-up">
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showStructureEditor && props.stored.container && (
        <BookStructureEditor
          container={props.stored.container}
          chapters={props.book.chapters.map(({ order, title, bookIndex, preview, contentType }) =>
            ({ order, title, bookIndex, preview, contentType }))}
          onSave={props.onSaveContainer}
          onClose={() => setShowStructureEditor(false)}
          mode="manage"
          onReextract={props.onReextractTitles}
        />
      )}

      <header className="bg-paper-raised border-b border-border px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={props.onClose}
          className="w-8 h-8 flex items-center justify-center text-ink-soft hover:text-ink transition-colors rounded-lg"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8"/>
          </svg>
        </button>
        <div className="min-w-0">
          <h2 className="font-serif text-lg font-semibold text-ink">Workshop</h2>
          <p className="text-xs font-mono text-ink-dim truncate">{props.book.title}</p>
        </div>
      </header>

      <div className="flex border-b border-border bg-paper-raised flex-shrink-0 overflow-x-auto scrollbar-none">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
              activeTab === key
                ? 'text-rust border-rust'
                : 'text-ink-soft border-transparent hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'chapters' && (
          <ChapterSelector
            chapters={props.book.chapters}
            currentIndex={props.currentIndex}
            onChange={props.onChapterChange}
            onAnalyze={props.onAnalyze}
            onCancelAnalyze={props.onCancelAnalyze}
            onRebuild={props.onRebuild}
            onCancelRebuild={props.onCancelRebuild}
            onProcessBook={props.onProcessBook}
            analyzing={props.analyzing}
            rebuilding={props.rebuilding}
            rebuildProgress={props.rebuildProgress}
            lastAnalyzedIndex={props.stored.lastAnalyzedIndex}
            snapshotIndices={props.snapshotIndices}
            visibleChapterOrders={props.visibleChapterOrders}
            chapterRange={props.chapterRange}
            onSetRange={props.onSetRange}
            onDeleteSnapshot={props.onDeleteSnapshot}
            readingBookmark={props.stored.readingBookmark}
            onSetBookmark={props.onSetBookmark}
            metaOnly={props.isMetaOnly}
            needsSetup={props.needsSetup}
            onCompleteSetup={props.onCompleteSetup}
          />
        )}

        {activeTab === 'structure' && (
          <div>
            {props.stored.container && props.stored.container.books.length > 1 && (
              <button
                onClick={() => setShowStructureEditor(true)}
                className="w-full px-4 py-3 rounded-xl border border-border text-left hover:border-rust/30 transition-colors"
              >
                <span className="text-sm font-serif text-ink">Edit Book Structure</span>
                <span className="text-xs font-mono text-ink-dim ml-2">
                  {props.stored.container.books.length} books
                </span>
              </button>
            )}
            {!props.stored.container && (
              <p className="text-sm font-serif text-ink-soft text-center py-12">
                No series structure detected for this book.
              </p>
            )}
          </div>
        )}

        {activeTab === 'entities' && props.result && (
          <EntityManager
            snapshots={props.stored.snapshots}
            currentResult={props.stored.result}
            chapterTitles={props.book.chapters.map((ch) => ch.title)}
            onResultEdit={props.onResultEdit}
            aggregated={props.derived.aggregated}
            bookTitle={props.book.title}
            bookAuthor={props.book.author}
            currentChapterIndex={props.currentChapterIndex}
          />
        )}

        {activeTab === 'library' && (
          <WorkshopLibrary
            savedBooks={props.savedBooks}
            currentBookTitle={props.book.title}
            onLoadBook={props.onLoadBook}
            onDeleteBook={props.onDeleteBook}
            onImportFile={props.onImportFile}
          />
        )}

        {activeTab === 'settings' && (
          <div>
            <button
              onClick={() => setShowSettings(true)}
              className="w-full px-4 py-3 rounded-xl border border-border text-left hover:border-rust/30 transition-colors"
            >
              <span className="text-sm font-serif text-ink">AI Provider Settings</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkshopLibrary({ savedBooks, currentBookTitle, onLoadBook, onDeleteBook, onImportFile }: {
  savedBooks: Array<{ title: string; author: string; lastAnalyzedIndex: number; chapterCount?: number }>;
  currentBookTitle: string;
  onLoadBook: (title: string, author: string) => void;
  onDeleteBook: (title: string, author: string) => void;
  onImportFile: (file: File) => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = savedBooks.filter((b) =>
    !search || b.title.toLowerCase().includes(search.toLowerCase()) || b.author.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <input
        type="search"
        placeholder="Search library..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full bg-paper border border-border rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-dim font-serif focus:outline-none focus:border-rust mb-4"
      />
      <div className="space-y-2">
        {filtered.map((book) => {
          const isCurrent = book.title === currentBookTitle;
          return (
            <div
              key={`${book.title}-${book.author}`}
              onClick={() => !isCurrent && onLoadBook(book.title, book.author)}
              className={`flex items-center gap-3 px-3 py-3 rounded-xl border transition-colors ${
                isCurrent
                  ? 'bg-rust/5 border-rust/20'
                  : 'border-border hover:border-rust/30 cursor-pointer'
              }`}
            >
              <BookCoverGradient title={book.title} className="w-10 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-serif font-medium truncate ${isCurrent ? 'text-rust' : 'text-ink'}`}>
                  {book.title}
                </p>
                <p className="text-xs font-mono text-ink-dim">{book.author}</p>
                <div className="flex gap-3 mt-1 text-xs font-mono text-ink-dim">
                  {book.lastAnalyzedIndex >= 0 && (
                    <span>Ch. {book.lastAnalyzedIndex + 1}{book.chapterCount ? `/${book.chapterCount}` : ''}</span>
                  )}
                </div>
              </div>
              {!isCurrent && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteBook(book.title, book.author); }}
                  className="text-ink-dim hover:text-danger transition-colors p-1"
                  title="Delete"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 3.5h8M5.5 3.5V2.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5.5 6v4M8.5 6v4M4 3.5l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-8"/>
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <label className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-rust text-white flex items-center justify-center shadow-lg cursor-pointer hover:bg-rust-soft transition-colors">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <input
          type="file"
          accept=".epub,.bookbuddy"
          className="sr-only"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.target.value = ''; }}
        />
      </label>
    </div>
  );
}
