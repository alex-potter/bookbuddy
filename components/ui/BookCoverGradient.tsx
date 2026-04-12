'use client';

const PALETTES = [
  ['#b5542b', '#c97a4f', '#e8dbc3'],
  ['#4f7579', '#6a9a9e', '#e8dbc3'],
  ['#c19024', '#d4a83a', '#f3ebdd'],
  ['#2c2319', '#6b5740', '#d9c9ab'],
  ['#a33a2a', '#c95a4a', '#f3ebdd'],
  ['#4f7579', '#c19024', '#f3ebdd'],
  ['#b5542b', '#4f7579', '#e8dbc3'],
  ['#6b5740', '#c19024', '#faf5e8'],
];

function hashString(str: string): number {
  let hash = 0;
  for (const c of str) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(hash);
}

interface BookCoverGradientProps {
  title: string;
  className?: string;
}

export default function BookCoverGradient({ title, className = '' }: BookCoverGradientProps) {
  const hash = hashString(title);
  const palette = PALETTES[hash % PALETTES.length];
  const angle = (hash % 360);

  return (
    <div
      className={`rounded-md flex items-end p-2 ${className}`}
      style={{
        background: `linear-gradient(${angle}deg, ${palette[0]}, ${palette[1]}, ${palette[2]})`,
        aspectRatio: '2/3',
      }}
    >
      <span
        className="text-[10px] font-serif font-semibold leading-tight line-clamp-2"
        style={{ color: palette[2] }}
      >
        {title}
      </span>
    </div>
  );
}
