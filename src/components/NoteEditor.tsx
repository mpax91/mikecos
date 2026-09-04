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
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { Attachment } from './AttachmentNode';
import { LinkModal } from './LinkModal';
import { api } from '../api/client';

const AUTOSAVE_DEBOUNCE_MS = 800;

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

function RowIcon({ remove }: { remove?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="14" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <rect
        x="1"
        y="9.5"
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
        <path d="M8 10.5v3M6.5 12h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      )}
    </svg>
  );
}

function ColIcon({ remove }: { remove?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="4.5" height="14" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <rect
        x="9.5"
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
        <path d="M11.75 6.5v3M10.25 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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

function HighlightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M4 12.5l1-3 5-5 2 2-5 5-3 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="2" y="13.3" width="6" height="1.4" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function TableControls({ editor }: { editor: Editor }) {
  if (!editor.isActive('table')) return null;
  return (
    <div className="editor-toolbar__table-controls">
      <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row below">
        <RowIcon />
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
}: {
  content: string | null;
  onSave: (json: string) => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingJson = useRef<string | null>(null);
  const [, forceRerender] = useState(0);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Mention.configure({
        suggestion: {
          // No mentionable entities exist yet in V1.0 — extension is wired in
          // now so future modules (people, projects) can populate this
          // without a content-model migration.
          items: () => [],
        },
      }),
      Highlight,
      Attachment,
    ],
    content: content ? JSON.parse(content) : '',
    onUpdate: ({ editor }) => {
      // Snapshot the JSON immediately (cheap) so a flush-on-unmount never
      // needs to touch a possibly-already-destroyed editor instance.
      const json = JSON.stringify(editor.getJSON());
      pendingJson.current = json;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        pendingJson.current = null;
        onSave(json);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    onSelectionUpdate: () => forceRerender((n) => n + 1),
    onTransaction: () => forceRerender((n) => n + 1),
  });

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

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
          },
        })
        .focus()
        .run();
    } catch {
      // Upload failed (network/server) — silently no-op; the toolbar stays
      // usable and the user can retry.
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

  return (
    <div className="note-editor">
      <div className="editor-toolbar">
        <BlockStyleDropdown editor={editor} />
        <div className="editor-toolbar__divider" />
        {btn(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), <b>B</b>, 'Bold')}
        {btn(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), <i>I</i>, 'Italic')}
        {btn(
          editor.isActive('underline'),
          () => editor.chain().focus().toggleUnderline().run(),
          <span style={{ textDecoration: 'underline' }}>U</span>,
          'Underline'
        )}
        {btn(
          editor.isActive('strike'),
          () => editor.chain().focus().toggleStrike().run(),
          <span style={{ textDecoration: 'line-through' }}>S</span>,
          'Strikethrough (cross out)'
        )}
        <div className="editor-toolbar__divider" />
        {btn(
          editor.isActive('bulletList'),
          () => editor.chain().focus().toggleBulletList().run(),
          <BulletListIcon />,
          'Bulleted list'
        )}
        {btn(
          editor.isActive('orderedList'),
          () => editor.chain().focus().toggleOrderedList().run(),
          <OrderedListIcon />,
          'Numbered list'
        )}
        {btn(
          editor.isActive('taskList'),
          () => editor.chain().focus().toggleTaskList().run(),
          <ChecklistIcon />,
          'Checklist'
        )}
        {btn(editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), '"', 'Quote')}
        {btn(
          editor.isActive('highlight'),
          () => editor.chain().focus().toggleHighlight().run(),
          <HighlightIcon />,
          'Highlight'
        )}
        <div className="editor-toolbar__divider" />
        {btn(
          false,
          () => editor.chain().focus().setHorizontalRule().run(),
          <DividerIcon />,
          'Section divider'
        )}
        {btn(
          editor.isActive('table'),
          () => insertSizedTable(editor),
          '⊞',
          'Insert table'
        )}
        <TableControls editor={editor} />
        <div className="editor-toolbar__divider" />
        {btn(false, () => imageInputRef.current?.click(), <ImageIcon />, 'Insert image')}
        {btn(false, () => fileInputRef.current?.click(), <FileIcon />, 'Attach PDF or file')}
        {btn(editor.isActive('link'), () => setLinkModalOpen(true), <LinkIcon />, 'Insert link')}
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
      <EditorContent editor={editor} />
      {linkModalOpen && <LinkModal onSave={handleAddLink} onClose={() => setLinkModalOpen(false)} />}
    </div>
  );
}
