import { useEffect, useRef, useState } from 'react';

export function NewMenu({
  onCreate,
  onAddLink,
  onUploadFile,
}: {
  onCreate: (type: 'folder' | 'note') => void;
  onAddLink: () => void;
  onUploadFile: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const items: { key: string; label: string; onClick: () => void }[] = [
    { key: 'folder', label: 'New Folder', onClick: () => onCreate('folder') },
    { key: 'note', label: 'New Note', onClick: () => onCreate('note') },
    { key: 'file', label: 'Upload File', onClick: () => fileInputRef.current?.click() },
    { key: 'link', label: 'Add Link', onClick: onAddLink },
  ];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUploadFile(file);
          e.target.value = '';
        }}
      />
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
          {items.map((item) => (
            <div
              key={item.key}
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(47,74,60,0.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
