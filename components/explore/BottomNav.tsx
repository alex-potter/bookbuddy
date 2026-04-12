'use client';

type ExploreTab = 'characters' | 'locations' | 'arcs' | 'map';

interface BottomNavProps {
  activeTab: ExploreTab;
  onChange: (tab: ExploreTab) => void;
}

const TABS: { key: ExploreTab; label: string; icon: JSX.Element }[] = [
  {
    key: 'characters',
    label: 'Characters',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    ),
  },
  {
    key: 'locations',
    label: 'Locations',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
        <circle cx="12" cy="10" r="3"/>
      </svg>
    ),
  },
  {
    key: 'arcs',
    label: 'Arcs',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="6" y1="3" x2="6" y2="15"/>
        <circle cx="18" cy="6" r="3"/>
        <circle cx="6" cy="18" r="3"/>
        <path d="M18 9a9 9 0 0 1-9 9"/>
      </svg>
    ),
  },
  {
    key: 'map',
    label: 'Map',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
  },
];

export default function BottomNav({ activeTab, onChange }: BottomNavProps) {
  return (
    <nav className="flex-shrink-0 bg-paper-raised border-t border-border flex items-center justify-around lg:fixed lg:left-0 lg:top-0 lg:h-full lg:w-16 lg:flex-col lg:justify-start lg:pt-4 lg:gap-2 lg:border-t-0 lg:border-r" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {TABS.map(({ key, label, icon }) => {
        const active = activeTab === key;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`flex flex-col items-center gap-0.5 py-2 px-3 min-w-[64px] transition-colors ${
              active ? 'text-rust' : 'text-ink-soft'
            }`}
          >
            {icon}
            <span className="text-[10px] font-medium">{label}</span>
            {active && <span className="w-1 h-1 rounded-full bg-rust" />}
          </button>
        );
      })}
    </nav>
  );
}
