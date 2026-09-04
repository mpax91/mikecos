import { useEffect, useRef, useState } from 'react';

export function NewMenu({
  onCreate,
}: {
  onCreate: (type: 'folder' | 'note' | 'task') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        + New
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            minWidth: 160,
            zIndex: 10,
            padding: 6,
            boxShadow: '0 4px 16px rgba(46, 42, 34, 0.12)',
          }}
        >
          {(['folder', 'note', 'task'] as const).map((type) => (
            <div
              key={type}
              onClick={() => {
                onCreate(type);
                setOpen(false);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                textTransform: 'capitalize',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(47,74,60,0.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              New {type}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
