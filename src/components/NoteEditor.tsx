import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Mention } from '@tiptap/extension-mention';
import { Highlight } from '@tiptap/extension-highlight';
import { TextAlign } from '@tiptap/extension-text-align';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { Attachment } from './AttachmentNode';
import { LinkPreview } from './LinkPreviewNode';
import { LinkModal } from './LinkModal';
import { api } from '../api/client';
import { useIsMobile } from '../hooks/useIsMobile';

const AUTOSAVE_DEBOUNCE_MS = 800;

/** The full extension set for a note/jot document — shared between the real
 * editing surface here and the read-only renderer used for Jot cards, so a
 * card's attachment/link-preview/checklist rendering never silently drifts
 * from how the same content looks while actually being edited. */
export function noteExtensions() {
  return [
    StarterKit.configure({
      link: {
        openOnClick: true,
        autolink: true,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Mention.configure({
      suggestion: {
        items: () => [],
      },
    }),
    Highlight,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Attachment,
    LinkPreview,
  ];
}

type BlockStyle = 'title' | 'heading' | 'subheading' | 'body';

const BLOCK_STYLES: { key: BlockStyle; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'heading', label: 'Heading' },
  { key: 'subheading', label: 'Subheading' },
  { key: 'body', label: 'Body' },
];

const DEFAULT_TABLE_COL_WIDTH = 120;

/**
 * Inserts a table and immediately gives every column an explicit pixel
 * colwidth. Without this, prosemirror-tables leaves new columns' widths
 * unset ("auto"); with table-layout:fixed, unset columns silently absorb
 * any space freed by shrinking a neighboring column, so the table's total
 * width never actually shrinks even though the dragged column does. Explicit
 * widths on every column make the table's total width the real sum of its
 * columns, so both growing and shrinking a column change the table's
 * overall width as expected.
 */
function insertSizedTable(editor: Editor) {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  const { state, view } = editor;
  const $from = state.selection.$from;
  let tablePos: number | null = null;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') {
      tablePos = $from.before(d);
      break;
    }
  }
  if (tablePos == null) return;
  const tableNode = state.doc.nodeAt(tablePos);
  if (!tableNode) return;
  const firstRow = tableNode.child(0);
  const tr = state.tr;
  let cellPos = tablePos + 2; // skip into table, then into first row
  firstRow.forEach((cell) => {
    tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, colwidth: [DEFAULT_TABLE_COL_WIDTH] });
    cellPos += cell.nodeSize;
  });
  view.dispatch(tr);
  ensureTrailingParagraph(editor);
}

/**
 * Tables and attachments are both atom/block nodes with no editable content
 * of their own, so if one ends up as the very last node in the document
 * there's nowhere left to click to keep writing below it — the cursor has
 * no paragraph to land in. Appending a blank paragraph after the doc's last
 * node whenever that last node isn't already a paragraph keeps a freeform
 * writing spot available beneath any table or attachment. Idempotent: once
 * the trailing paragraph exists this is a no-op, so it's safe to call after
 * every edit without looping.
 */
function ensureTrailingParagraph(editor: Editor) {
  const { doc } = editor.state;
  const last = doc.lastChild;
  if (last && last.type.name !== 'paragraph') {
    editor.chain().insertContentAt(doc.content.size, { type: 'paragraph' }).run();
  }
}

function activeBlockStyle(editor: Editor): BlockStyle {
  if (editor.isActive('heading', { level: 1 })) return 'title';
  if (editor.isActive('heading', { level: 2 })) return 'heading';
  if (editor.isActive('heading', { level: 3 })) return 'subheading';
  return 'body';
}

function applyBlockStyle(editor: Editor, style: BlockStyle) {
  const chain = editor.chain().focus();
  if (style === 'title') chain.setHeading({ level: 1 }).run();
  else if (style === 'heading') chain.setHeading({ level: 2 }).run();
  else if (style === 'subheading') chain.setHeading({ level: 3 }).run();
  else chain.setParagraph().run();
}

function BlockStyleDropdown({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const current = activeBlockStyle(editor);
  const currentLabel = BLOCK_STYLES.find((s) => s.key === current)?.label ?? 'Body';

  return (
    <div ref={ref} className="editor-toolbar__dropdown-wrap">
      <button type="button" className="editor-toolbar__btn editor-toolbar__aa" onClick={() => setOpen((v) => !v)}>
        <span style={{ fontWeight: 600 }}>Aa</span>
        <span className="editor-toolbar__aa-label">{currentLabel}</span>
      </button>
      {open && (
        <div className="editor-toolbar__dropdown card">
          {BLOCK_STYLES.map((s) => (
            <div
              key={s.key}
              className={`editor-toolbar__dropdown-item editor-toolbar__style-${s.key}${
                current === s.key ? ' is-active' : ''
              }`}
              onClick={() => {
                applyBlockStyle(editor, s.key);
                setOpen(false);
              }}
            >
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BulletListIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="2.5" cy="4" r="1.3" fill="currentColor" />
      <circle cx="2.5" cy="8" r="1.3" fill="currentColor" />
      <circle cx="2.5" cy="12" r="1.3" fill="currentColor" />
      <rect x="6" y="3.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="6" y="7.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="6" y="11.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function OrderedListIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <text x="0" y="5.2" fontSize="4.5" fontWeight="600" fill="currentColor">1</text>
      <text x="0" y="9.2" fontSize="4.5" fontWeight="600" fill="currentColor">2</text>
      <text x="0" y="13.2" fontSize="4.5" fontWeight="600" fill="currentColor">3</text>
      <rect x="6" y="3.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="6" y="7.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="6" y="11.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function ChecklistIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="0.5" y="1.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.4 3.5L2.3 4.4L4 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6" y="2.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="0.5" y="7.5" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6" y="8.2" width="9" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function DividerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="7.2" width="14" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function RowIcon({ remove, above }: { remove?: boolean; above?: boolean }) {
  // The dashed/highlighted rect marks where the new row lands — on top when
  // `above`, on the bottom otherwise — so "add row above" and "add row
  // below" read as visually distinct buttons rather than duplicates.
  const newRectY = above ? 1 : 9.5;
  const solidRectY = above ? 9.5 : 1;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y={solidRectY} width="14" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <rect
        x="1"
        y={newRectY}
        width="14"
        height="4.5"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeDasharray={remove ? undefined : '2 1.4'}
        fill={remove ? 'currentColor' : 'none'}
        fillOpacity={remove ? 0.15 : 1}
      />
      {remove ? (
        <path d="M5.5 11.75h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <path
          d={above ? 'M8 2.5v3M6.5 4h3' : 'M8 10.5v3M6.5 12h3'}
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function ColIcon({ remove, left }: { remove?: boolean; left?: boolean }) {
  const newRectX = left ? 1 : 9.5;
  const solidRectX = left ? 9.5 : 1;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x={solidRectX} y="1" width="4.5" height="14" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <rect
        x={newRectX}
        y="1"
        width="4.5"
        height="14"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeDasharray={remove ? undefined : '2 1.4'}
        fill={remove ? 'currentColor' : 'none'}
        fillOpacity={remove ? 0.15 : 1}
      />
      {remove ? (
        <path d="M10.25 8h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <path
          d={left ? 'M2.75 6.5v3M1.25 8h3' : 'M11.75 6.5v3M10.25 8h3'}
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 4h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M5.5 4V2.7c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 4l.6 9.1c0 .5.5.9 1 .9h4.8c.5 0 .9-.4 1-.9L12 4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.5 6.5v5M9.5 6.5v5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5.2" cy="6" r="1.2" fill="currentColor" />
      <path d="M2.5 11.5l3.5-3.5 2.5 2.5 2-2 3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 1.5h6l3 3v9.5a1 1 0 01-1 1h-8a1 1 0 01-1-1v-11.5a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 1.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M6.8 9.2a3 3 0 000 4.2l0 0a3 3 0 004.2 0l1.8-1.8a3 3 0 00-4.2-4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.2 6.8a3 3 0 000-4.2l0 0a3 3 0 00-4.2 0L3.2 4.4a3 3 0 004.2 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// A link glyph inside a small card outline — distinguishes "insert a rich
// preview card" from the plain inline-hyperlink LinkIcon above.
function LinkPreviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2.5" width="14" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.2 8.9a2 2 0 000 2.8l0 0a2 2 0 002.8 0l1.1-1.1a2 2 0 00-2.8-2.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M8 7.1a2 2 0 000-2.8l0 0a2 2 0 00-2.8 0L4.1 5.4a2 2 0 002.8 2.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function AlignLeftIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2.5" width="14" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1" y="6.7" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1" y="10.9" width="12" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function AlignCenterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2.5" width="14" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="3.5" y="6.7" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="2" y="10.9" width="12" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2.5" width="14" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="6" y="6.7" width="9" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="3" y="10.9" width="12" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function AlignJustifyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2.5" width="14" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1" y="6.7" width="14" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="1" y="10.9" width="14" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function HighlightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M4 12.5l1-3 5-5 2 2-5 5-3 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="2" y="13.3" width="6" height="1.4" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}

function TableControls({ editor }: { editor: Editor }) {
  if (!editor.isActive('table')) return null;
  return (
    <div className="editor-toolbar__table-controls">
      <button type="button" onClick={() => editor.chain().focus().addRowBefore().run()} title="Add row above">
        <RowIcon above />
      </button>
      <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row below">
        <RowIcon />
      </button>
      <button type="button" onClick={() => editor.chain().focus().addColumnBefore().run()} title="Add column left">
        <ColIcon left />
      </button>
      <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()} title="Add column right">
        <ColIcon />
      </button>
      <button type="button" onClick={() => editor.chain().focus().deleteRow().run()} title="Delete row">
        <RowIcon remove />
      </button>
      <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()} title="Delete column">
        <ColIcon remove />
      </button>
      <button
        type="button"
        className="editor-toolbar__table-controls-danger"
        onClick={() => editor.chain().focus().deleteTable().run()}
        title="Delete table"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

export function NoteEditor({
  content,
  onSave,
  onChange,
  autoFocus,
  compact,
}: {
  content: string | null;
  onSave: (json: string) => void;
  /** Fires synchronously on every keystroke (unlike onSave, which is
   * debounced) — used by the Jots composer to know the document's current
   * emptiness right when "Done" is clicked, without racing the save
   * debounce. Most callers (plain Notes) don't need this. */
  onChange?: (json: string) => void;
  /** Focuses the body editor (not any title field, which lives outside this
   * component) as soon as it mounts — used by Jots so opening the composer
   * or an existing jot drops the cursor straight into the text, Keep-style,
   * with no extra click. Only takes effect at construction time, so callers
   * that need a fresh focus per-open should remount via a `key` prop
   * (both the Jots composer and JotPanel already do, keyed by draft/jot id). */
  autoFocus?: boolean;
  /** Shrinks the toolbar to a small, quick-capture-friendly core set (Bold,
   * Italic, Checklist, Link, Insert image) with everything else tucked
   * behind a "More" toggle — used by Jots, on both mobile and desktop,
   * independent of the isMobile-driven collapse below (which uses a
   * different, larger core set and stays exactly as-is for Notes). */
  compact?: boolean;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingJson = useRef<string | null>(null);
  const [, forceRerender] = useState(0);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkPreviewModalOpen, setLinkPreviewModalOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  // On phone widths (or always, in compact mode) the ribbon collapses to
  // core buttons only, with everything else (alignment, quote, highlight,
  // divider, table, image/file insert) tucked behind this "more" toggle.
  // Desktop, non-compact usage always shows everything inline, same as
  // before, so this flag is simply ignored there.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const showMoreToggle = isMobile || compact;
  const showExtras = compact ? overflowOpen : !isMobile || overflowOpen;

  const editor = useEditor({
    extensions: noteExtensions(),
    content: content ? JSON.parse(content) : '',
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor }) => {
      // Snapshot the JSON immediately (cheap) so a flush-on-unmount never
      // needs to touch a possibly-already-destroyed editor instance.
      const json = JSON.stringify(editor.getJSON());
      pendingJson.current = json;
      onChangeRef.current?.(json);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        pendingJson.current = null;
        onSave(json);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    onCreate: ({ editor }) => ensureTrailingParagraph(editor),
    onSelectionUpdate: () => forceRerender((n) => n + 1),
    onTransaction: () => forceRerender((n) => n + 1),
  });

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Flush any pending debounced save on unmount (e.g. navigating away right
  // after typing) so edits are never silently dropped.
  useEffect(() => {
    return () => {
      if (saveTimer.current && pendingJson.current !== null) {
        clearTimeout(saveTimer.current);
        onSaveRef.current(pendingJson.current);
      }
    };
  }, []);

  async function handleAttachmentPick(file: File | undefined) {
    if (!file || !editor) return;
    // Capture the cursor position before the async upload — by the time it
    // resolves, focus may have moved (the native file-picker dialog steals
    // it), and re-focusing afterward doesn't reliably restore the same
    // selection. Inserting at this locked-in position sidesteps that.
    const insertPos = editor.state.selection.to;
    try {
      const uploaded = await api.uploadInline(file);
      if (editor.isDestroyed) return;
      editor
        .chain()
        .insertContentAt(insertPos, {
          type: 'attachment',
          attrs: {
            url: uploaded.url,
            filename: uploaded.filename,
            mimeType: uploaded.mime_type,
            r2Key: uploaded.r2_key,
            size: uploaded.size,
          },
        })
        .focus()
        .run();
      ensureTrailingParagraph(editor);
    } catch {
      // Upload failed (network/server) — silently no-op; the toolbar stays
      // usable and the user can retry.
    }
  }

  async function handleAddLinkPreview(url: string) {
    setLinkPreviewModalOpen(false);
    if (!editor) return;
    const insertPos = editor.state.selection.to;
    // Insert immediately with just the domain known, then fill in the
    // fetched title/image once it resolves — the card never blocks on the
    // network, it just upgrades a beat later (or stays domain-only if the
    // target couldn't be unfurled).
    let domain = url;
    try {
      domain = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    } catch {
      // leave domain as the raw string
    }
    editor
      .chain()
      .insertContentAt(insertPos, { type: 'linkPreview', attrs: { url, title: null, image: null, domain } })
      .focus()
      .run();
    ensureTrailingParagraph(editor);

    try {
      const preview = await api.fetchLinkPreview(url);
      if (editor.isDestroyed) return;
      // Find the node we just inserted (by url + still-null title, so an
      // identical link added twice doesn't collide) and patch its attrs.
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (targetPos === null && node.type.name === 'linkPreview' && node.attrs.url === url && node.attrs.title === null) {
          targetPos = pos;
        }
      });
      if (targetPos !== null) {
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(targetPos as number, undefined, {
              url: preview.url,
              title: preview.title,
              image: preview.image,
              domain: preview.domain,
            });
            return true;
          })
          .run();
        // setNodeMarkup doesn't itself trigger onUpdate's autosave — nudge it.
        onSaveRef.current(JSON.stringify(editor.getJSON()));
      }
    } catch {
      // Unfurl failed — the domain-only card inserted above stands as-is.
    }
  }

  function handleAddLink(url: string, label: string) {
    setLinkModalOpen(false);
    if (!editor) return;
    if (editor.state.selection.empty) {
      editor.chain().focus().insertContent(label || url).run();
      const from = editor.state.selection.from - (label || url).length;
      editor
        .chain()
        .setTextSelection({ from, to: editor.state.selection.from })
        .setLink({ href: url })
        .setTextSelection(editor.state.selection.from)
        .run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }

  if (!editor) return null;

  const btn = (
    active: boolean,
    onClick: () => void,
    label: ReactNode,
    title: string
  ) => (
    <button
      type="button"
      className={`editor-toolbar__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );

  // A table or attachment is a self-contained block with no editable text
  // of its own, so if it's the last thing in the document there's no
  // paragraph left to click into below it. ensureTrailingParagraph keeps one
  // there; clicking in the empty space below the last block (rather than on
  // a block itself) just needs to move the cursor into it.
  function handleContentAreaClick(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return; // a click on real content already placed the cursor
    ensureTrailingParagraph(editor);
    editor.chain().focus('end').run();
  }

  const boldBtn = btn(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), <b>B</b>, 'Bold');
  const italicBtn = btn(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), <i>I</i>, 'Italic');
  const underlineBtn = btn(
    editor.isActive('underline'),
    () => editor.chain().focus().toggleUnderline().run(),
    <span style={{ textDecoration: 'underline' }}>U</span>,
    'Underline'
  );
  const strikeBtn = btn(
    editor.isActive('strike'),
    () => editor.chain().focus().toggleStrike().run(),
    <span style={{ textDecoration: 'line-through' }}>S</span>,
    'Strikethrough (cross out)'
  );
  const bulletBtn = btn(
    editor.isActive('bulletList'),
    () => editor.chain().focus().toggleBulletList().run(),
    <BulletListIcon />,
    'Bulleted list'
  );
  const orderedBtn = btn(
    editor.isActive('orderedList'),
    () => editor.chain().focus().toggleOrderedList().run(),
    <OrderedListIcon />,
    'Numbered list'
  );
  const checklistBtn = btn(
    editor.isActive('taskList'),
    () => editor.chain().focus().toggleTaskList().run(),
    <ChecklistIcon />,
    'Checklist'
  );
  const linkBtn = btn(editor.isActive('link'), () => setLinkModalOpen(true), <LinkIcon />, 'Insert link');
  const linkPreviewBtn = btn(false, () => setLinkPreviewModalOpen(true), <LinkPreviewIcon />, 'Insert link preview');
  const alignLeftBtn = btn(
    editor.isActive({ textAlign: 'left' }),
    () => editor.chain().focus().setTextAlign('left').run(),
    <AlignLeftIcon />,
    'Align left'
  );
  const alignCenterBtn = btn(
    editor.isActive({ textAlign: 'center' }),
    () => editor.chain().focus().setTextAlign('center').run(),
    <AlignCenterIcon />,
    'Align center'
  );
  const alignRightBtn = btn(
    editor.isActive({ textAlign: 'right' }),
    () => editor.chain().focus().setTextAlign('right').run(),
    <AlignRightIcon />,
    'Align right'
  );
  const alignJustifyBtn = btn(
    editor.isActive({ textAlign: 'justify' }),
    () => editor.chain().focus().setTextAlign('justify').run(),
    <AlignJustifyIcon />,
    'Justify'
  );
  const quoteBtn = btn(editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), '"', 'Quote');
  const highlightBtn = btn(
    editor.isActive('highlight'),
    () => editor.chain().focus().toggleHighlight().run(),
    <HighlightIcon />,
    'Highlight'
  );
  const hrBtn = btn(false, () => editor.chain().focus().setHorizontalRule().run(), <DividerIcon />, 'Section divider');
  const tableBtn = btn(editor.isActive('table'), () => insertSizedTable(editor), '⊞', 'Insert table');
  const imageBtn = btn(false, () => imageInputRef.current?.click(), <ImageIcon />, 'Insert image');
  const fileBtn = btn(false, () => fileInputRef.current?.click(), <FileIcon />, 'Attach PDF or file');
  const moreToggleBtn = (
    <button
      type="button"
      className={`editor-toolbar__btn${overflowOpen ? ' is-active' : ''}`}
      onClick={() => setOverflowOpen((v) => !v)}
      title="More formatting"
    >
      <MoreIcon />
    </button>
  );

  return (
    <div className="note-editor">
      <div className="editor-toolbar">
        {compact ? (
          <>
            {boldBtn}
            {italicBtn}
            {underlineBtn}
            {strikeBtn}
            <div className="editor-toolbar__divider" />
            {bulletBtn}
            {orderedBtn}
            {checklistBtn}
            <div className="editor-toolbar__divider" />
            {linkBtn}
            {imageBtn}
            {showMoreToggle && moreToggleBtn}
            {showExtras && (
              <>
                {linkPreviewBtn}
                <div className="editor-toolbar__divider" />
                <BlockStyleDropdown editor={editor} />
                <div className="editor-toolbar__divider" />
                {alignLeftBtn}
                {alignCenterBtn}
                {alignRightBtn}
                {alignJustifyBtn}
                <div className="editor-toolbar__divider" />
                {quoteBtn}
                {highlightBtn}
                <div className="editor-toolbar__divider" />
                {hrBtn}
                {tableBtn}
                <TableControls editor={editor} />
                <div className="editor-toolbar__divider" />
                {fileBtn}
              </>
            )}
          </>
        ) : (
          <>
            {!isMobile && (
              <>
                <BlockStyleDropdown editor={editor} />
                <div className="editor-toolbar__divider" />
              </>
            )}
            {boldBtn}
            {italicBtn}
            {underlineBtn}
            {strikeBtn}
            <div className="editor-toolbar__divider" />
            {bulletBtn}
            {orderedBtn}
            {checklistBtn}
            <div className="editor-toolbar__divider" />
            {linkBtn}
            {linkPreviewBtn}
            {showMoreToggle && moreToggleBtn}
            {showExtras && (
              <>
                {isMobile && (
                  <>
                    <BlockStyleDropdown editor={editor} />
                    <div className="editor-toolbar__divider" />
                  </>
                )}
                {alignLeftBtn}
                {alignCenterBtn}
                {alignRightBtn}
                {alignJustifyBtn}
                <div className="editor-toolbar__divider" />
                {quoteBtn}
                {highlightBtn}
                <div className="editor-toolbar__divider" />
                {hrBtn}
                {tableBtn}
                <TableControls editor={editor} />
                <div className="editor-toolbar__divider" />
                {imageBtn}
                {fileBtn}
              </>
            )}
          </>
        )}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleAttachmentPick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleAttachmentPick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <div className="note-editor__content-area" onClick={handleContentAreaClick}>
        <EditorContent editor={editor} />
      </div>
      {linkModalOpen && <LinkModal onSave={handleAddLink} onClose={() => setLinkModalOpen(false)} />}
      {linkPreviewModalOpen && (
        <LinkModal
          heading="Insert Link Preview"
          submitLabel="Insert"
          showLabelField={false}
          onSave={(url) => handleAddLinkPreview(url)}
          onClose={() => setLinkPreviewModalOpen(false)}
        />
      )}
    </div>
  );
}
