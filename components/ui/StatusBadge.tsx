'use client';

interface StatusBadgeProps {
  status: 'alive' | 'dead' | 'unknown' | 'uncertain' | 'active' | 'resolved' | 'dormant';
  size?: 'sm' | 'md';
}

const CONFIG: Record<string, { label: string; dot: string; bg: string }> = {
  alive:     { label: 'Alive',     dot: 'bg-emerald-500', bg: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  dead:      { label: 'Dead',      dot: 'bg-danger',      bg: 'bg-danger/10 text-danger' },
  unknown:   { label: 'Unknown',   dot: 'bg-ink-dim',     bg: 'bg-ink-dim/10 text-ink-soft' },
  uncertain: { label: 'Uncertain', dot: 'bg-amber',       bg: 'bg-amber/10 text-amber' },
  active:    { label: 'Active',    dot: 'bg-teal',        bg: 'bg-teal/10 text-teal' },
  resolved:  { label: 'Resolved',  dot: 'bg-ink-soft',    bg: 'bg-ink-soft/10 text-ink-soft' },
  dormant:   { label: 'Dormant',   dot: 'bg-amber',       bg: 'bg-amber/10 text-amber' },
};

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const cfg = CONFIG[status] ?? CONFIG.unknown;
  const sizeClasses = size === 'sm'
    ? 'text-[10px] px-1.5 py-0.5 gap-1'
    : 'text-xs px-2 py-0.5 gap-1.5';

  return (
    <span className={`inline-flex items-center font-mono font-bold uppercase rounded ${sizeClasses} ${cfg.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}
