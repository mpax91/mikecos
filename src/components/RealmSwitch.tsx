import { useRealm } from '../contexts/RealmContext';
import type { RealmFilter } from '../utils/realm';

const OPTIONS: { value: RealmFilter; label: string; icon: string }[] = [
  { value: 'all', label: 'All', icon: '' },
  { value: 'personal', label: 'Personal', icon: '🏡' },
  { value: 'work', label: 'Work', icon: '💼' },
];

/** The app-wide All / Personal / Work switch — lives in the top bar so it's
 * on every screen. Every list in the app follows it; new items are created
 * in Work while Work is on. */
export function RealmSwitch() {
  const { realm, setRealm } = useRealm();
  return (
    <div className={`realm-switch realm-switch--${realm}`} role="radiogroup" aria-label="Show Personal, Work or All">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={realm === o.value}
          className={`realm-switch__opt realm-switch__opt--${o.value}${realm === o.value ? ' is-active' : ''}`}
          onClick={() => setRealm(o.value)}
          title={o.value === 'all' ? 'Show everything' : `Show only ${o.label}`}
        >
          {o.icon && (
            <span className="realm-switch__icon" aria-hidden="true">
              {o.icon}
            </span>
          )}
          <span className="realm-switch__label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Small "Work" / "Personal" tag for rows and cards — only shown while the
 * switch is on All (when a filter is on, everything on screen is that realm). */
export function RealmChip({ realm, always = false }: { realm?: string | null; always?: boolean }) {
  const { realm: filter } = useRealm();
  if (!realm) return null;
  if (!always && (filter !== 'all' || realm !== 'work')) return null;
  return <span className={`realm-chip realm-chip--${realm}`}>{realm === 'work' ? 'Work' : 'Personal'}</span>;
}

/** Work / Personal toggle for one item (task, project, note, contact…). */
export function RealmToggle({ value, onChange, size = 'md' }: { value?: string | null; onChange: (r: 'personal' | 'work') => void; size?: 'sm' | 'md' }) {
  const v = value === 'work' ? 'work' : 'personal';
  return (
    <div className={`realm-toggle realm-toggle--${size}`} role="radiogroup" aria-label="Personal or Work">
      {(['personal', 'work'] as const).map((r) => (
        <button key={r} type="button" role="radio" aria-checked={v === r} className={`realm-toggle__opt realm-toggle__opt--${r}${v === r ? ' is-active' : ''}`} onClick={() => v !== r && onChange(r)}>
          {r === 'work' ? '💼 Work' : '🏡 Personal'}
        </button>
      ))}
    </div>
  );
}
