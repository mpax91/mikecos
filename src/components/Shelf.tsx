import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { FileMeta, ShelfItem, ShelfLinkContent, ShelfTextContent } from '../api/types';
import { KebabMenu } from './KebabMenu';
import { Toast } from './Toast';
import { formatRelativeTime } from '../utils/formatRelativeTime';

// A loose "is this one bare URL, not a sentence that happens to contain a
// link" check — deliberately stricter than a full URL-detection regex
// (which would also match "see docs.google.com in the meeting notes" and
// misfile a text snippet as a link). No internal whitespace, and it has to
// look like a host: something.tld, optionally with a scheme/path.
function isLikelyBareUrl(text: string): boolean {
  if (/\s/.test(text)) return false;
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(text);
}

function isImageMime(mime: string) {
  return mime.startsWith('image/');
}

function ShelfDropTile({ onFiles, onText }: { onFiles: (files: File[]) => void; onText: (text: string) => void }) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (composing) inputRef.current?.focus();
  }, [composing]);

  function submit() {
    const text = draft.trim();
    setComposing(false);
    setDraft('');
    if (text) onText(text);
  }

  if (composing) {
    return (
      <div className="shelf-tile shelf-drop shelf-drop--composing">
        <textarea
          ref={inputRef}
          className="shelf-drop__input"
          value={draft}
          placeholder="Type or paste…"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              setDraft('');
              setComposing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`shelf-tile shelf-drop${dragOver ? ' is-drag-over' : ''}`}
      onClick={() => setComposing(true)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
    >
      <div className="shelf-drop__icon">＋</div>
      <div className="shelf-drop__text">Paste or drop anything here</div>
      <div className="shelf-drop__sub">⌘V · drag files · click to type</div>
    </div>
  );
}

function ShelfTile({
  item,
  onCopy,
  onTogglePin,
  onGraduate,
  onDelete,
}: {
  item: ShelfItem;
  onCopy: (item: ShelfItem) => void;
  onTogglePin: (item: ShelfItem) => void;
  onGraduate: (item: ShelfItem) => void;
  onDelete: (item: ShelfItem) => void;
}) {
  const isPinned = item.pinned === 1;
  const isDownloadable = item.type === 'image' || item.type === 'file';
  const menu = [
    // Same convention as EntityCard's file-download item: a dedicated,
    // called-out Download action, since clicking the tile body only copies
    // (an image's copy path may fall back to copying its URL rather than
    // the actual bytes — Download is the one guaranteed way to get the file).
    ...(isDownloadable
      ? [
          {
            label: 'Download',
            onClick: () => {
              const meta = JSON.parse(item.content) as FileMeta;
              window.open(api.fileUrl(meta.r2_key, true), '_blank');
            },
            positive: true,
          },
        ]
      : []),
    { label: isPinned ? 'Unpin' : 'Pin to top', onClick: () => onTogglePin(item), separatorBefore: isDownloadable },
    { label: 'Save as Jot', onClick: () => onGraduate(item) },
    { label: 'Delete', onClick: () => onDelete(item), danger: true, separatorBefore: true },
  ];

  let body: React.ReactNode;
  let kindIcon = '✎';

  if (item.type === 'text') {
    const meta = JSON.parse(item.content) as ShelfTextContent;
    body = <div className="shelf-tile__snippet">{meta.text}</div>;
  } else if (item.type === 'link') {
    const meta = JSON.parse(item.content) as ShelfLinkContent;
    kindIcon = '🔗';
    body = (
      <>
        <div className="shelf-tile__domain">🔗 {meta.domain || 'link'}</div>
        <div className="shelf-tile__snippet">{meta.title || meta.url}</div>
      </>
    );
  } else {
    const meta = JSON.parse(item.content) as FileMeta;
    const isImage = item.type === 'image' || isImageMime(meta.mime_type);
    const isPdf = meta.mime_type === 'application/pdf';
    kindIcon = isImage ? '🖼️' : '📄';
    body = isImage ? (
      <img className="shelf-tile__thumb" src={api.fileUrl(meta.r2_key)} alt={meta.filename} draggable={false} />
    ) : (
      <>
        <div className={`shelf-tile__file-icon${isPdf ? ' is-pdf' : ''}`}>{isPdf ? '▤' : '📎'}</div>
        <div className="shelf-tile__filename">{meta.filename}</div>
      </>
    );
  }

  const modifier = item.type === 'image' ? ' shelf-tile--image' : item.type === 'file' ? ' shelf-tile--file' : '';

  return (
    <div className={`shelf-tile${modifier}`}>
      <span className="shelf-tile__kind">{isPinned ? '📌' : kindIcon}</span>
      <button type="button" className="shelf-tile__close" title="Remove" onClick={() => onDelete(item)}>
        ✕
      </button>
      <div className="shelf-tile__body" onClick={() => onCopy(item)} title="Click to copy">
        {body}
      </div>
      <div className="shelf-tile__foot">
        <span className="shelf-tile__time">{formatRelativeTime(item.created_at)}</span>
        <KebabMenu items={menu} />
      </div>
    </div>
  );
}

/** The Shelf — a drop zone sitting above the Jot cards on the Jots page:
 * paste (or drag, or type) a snippet/screenshot/link/file and it shows up
 * as a small disposable tile, no title or editor required. Same idea as
 * Jots ("quick capture, deliberately temporary") at an even lighter unit —
 * one atomic thing per tile instead of a little document. Deliberately no
 * auto-clear: items sit here until deleted one at a time, same as anything
 * else in the app — nothing here vanishes on a timer Mike doesn't control.
 * "Save as Jot" graduates one into a real, permanent Jot when it's worth
 * keeping; "Pin to top" just reorders it to the front, same as Jots,
 * Boards, and Projects. */
export function Shelf({ composerOpen, onGraduated }: { composerOpen: boolean; onGraduated?: () => void }) {
  const [items, setItems] = useState<ShelfItem[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listShelf().then(setItems).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dropFiles = useCallback((files: File[]) => {
    files.forEach(async (file) => {
      try {
        const uploaded = await api.uploadInline(file);
        const meta = { r2_key: uploaded.r2_key, mime_type: uploaded.mime_type, filename: uploaded.filename };
        const item = await api.dropShelfItem(isImageMime(uploaded.mime_type) ? 'image' : 'file', meta);
        setItems((prev) => (prev ? [item, ...prev] : [item]));
      } catch {
        // Upload failed — the shelf stays usable, nothing left half-created.
      }
    });
  }, []);

  const dropText = useCallback(async (text: string) => {
    if (isLikelyBareUrl(text)) {
      try {
        const preview = await api.fetchLinkPreview(text);
        const item = await api.dropShelfItem('link', preview);
        setItems((prev) => (prev ? [item, ...prev] : [item]));
        return;
      } catch {
        // Unfurl failed — fall through and park it as plain text instead of
        // losing the drop entirely.
      }
    }
    const item = await api.dropShelfItem('text', { text });
    setItems((prev) => (prev ? [item, ...prev] : [item]));
  }, []);

  // Same "only claim an unfocused paste" guard NoteEditor's own document-
  // level paste fallback uses (see NoteEditor.tsx) — and explicitly steps
  // aside whenever the Jots composer is open, since that NoteEditor
  // instance is the one that should claim it then, exactly as it already
  // does for a Note/Task editor elsewhere in the app.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (composerOpen) return;
      const target = e.target;
      if (target !== document.body && target !== document.documentElement) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        dropFiles(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text) {
        e.preventDefault();
        dropText(text);
      }
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [composerOpen, dropFiles, dropText]);

  async function handleCopy(item: ShelfItem) {
    try {
      if (item.type === 'text') {
        await navigator.clipboard.writeText((JSON.parse(item.content) as ShelfTextContent).text);
      } else if (item.type === 'link') {
        await navigator.clipboard.writeText((JSON.parse(item.content) as ShelfLinkContent).url);
      } else {
        const meta = JSON.parse(item.content) as FileMeta;
        const url = api.fileUrl(meta.r2_key);
        if (item.type === 'image' && 'ClipboardItem' in window) {
          try {
            const blob = await (await fetch(url)).blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          } catch {
            await navigator.clipboard.writeText(url);
          }
        } else {
          await navigator.clipboard.writeText(url);
        }
      }
      setToast('Copied to clipboard');
    } catch {
      // Clipboard access denied/unsupported — no-op rather than an error
      // the user can't do anything about.
    }
  }

  async function handleTogglePin(item: ShelfItem) {
    const next = item.pinned === 1 ? false : true;
    setItems((prev) => (prev ? prev.map((it) => (it.id === item.id ? { ...it, pinned: next ? 1 : 0 } : it)) : prev));
    await api.setShelfItemPinned(item.id, next);
  }

  async function handleGraduate(item: ShelfItem) {
    setItems((prev) => (prev ? prev.filter((it) => it.id !== item.id) : prev));
    await api.graduateShelfItem(item.id);
    setToast('Saved as a Jot');
    onGraduated?.();
  }

  async function handleDelete(item: ShelfItem) {
    setItems((prev) => (prev ? prev.filter((it) => it.id !== item.id) : prev));
    await api.deleteShelfItem(item.id);
  }

  return (
    <div className="shelf">
      <div className="shelf__head">
        <span className="shelf__label">Shelf</span>
        {items && items.length > 0 && (
          <span className="shelf__meta">
            {items.length} thing{items.length === 1 ? '' : 's'} parked here
          </span>
        )}
      </div>

      <div className="shelf__track">
        <ShelfDropTile onFiles={dropFiles} onText={dropText} />
        {items?.map((item) => (
          <ShelfTile
            key={item.id}
            item={item}
            onCopy={handleCopy}
            onTogglePin={handleTogglePin}
            onGraduate={handleGraduate}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
