'use client';

interface Props {
  onClick: () => void;
}

export default function SearchFAB({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      aria-label="Search entities"
      className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-stone-800 dark:bg-zinc-700 text-white shadow-lg active:scale-95 transition-transform"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
        <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
      </svg>
    </button>
  );
}
