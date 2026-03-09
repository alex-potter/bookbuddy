'use client';

interface SavedBook {
  title: string;
  author: string;
  lastAnalyzedIndex: number;
}

interface Props {
  newBookTitle: string;
  newBookAuthor: string;
  savedBooks: SavedBook[];
  onContinueFrom: (title: string, author: string) => void;
  onStartFresh: () => void;
}

export default function SeriesPicker({
  newBookTitle,
  newBookAuthor,
  savedBooks,
  onContinueFrom,
  onStartFresh,
}: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md w-full p-6">
        <div className="mb-5">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">New book loaded</p>
          <h2 className="font-bold text-zinc-100 text-lg leading-snug">{newBookTitle}</h2>
          <p className="text-sm text-zinc-500 mt-0.5">{newBookAuthor}</p>
          <p className="mt-3 text-sm text-zinc-400">
            Continue a series? Carry your character roster forward from a previous book.
          </p>
        </div>

        <div className="space-y-2 mb-4">
          {savedBooks.map((book) => (
            <button
              key={`${book.title}::${book.author}`}
              onClick={() => onContinueFrom(book.title, book.author)}
              className="w-full text-left px-4 py-3 rounded-xl border border-zinc-700 hover:border-amber-500/50 hover:bg-zinc-800 transition-colors group"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-zinc-200 text-sm truncate">{book.title}</p>
                  <p className="text-xs text-zinc-500 truncate">{book.author}</p>
                </div>
                <span className="flex-shrink-0 text-xs text-amber-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                  Continue →
                </span>
              </div>
              <p className="text-xs text-zinc-600 mt-1">
                {book.lastAnalyzedIndex + 1} chapter{book.lastAnalyzedIndex !== 0 ? 's' : ''} analyzed
              </p>
            </button>
          ))}
        </div>

        <button
          onClick={onStartFresh}
          className="w-full py-2.5 rounded-xl text-sm font-medium border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
        >
          Start fresh — standalone book
        </button>
      </div>
    </div>
  );
}
