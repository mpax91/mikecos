import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Mention } from '@tiptap/extension-mention';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';

const AUTOSAVE_DEBOUNCE_MS = 800;

type BlockStyle = 'title' | 'heading' | 'subheading' | 'body';

const BLOCK_STYLES: { key: BlockStyle; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'heading', label: 'Heading' },
  { key: 'subheading', label: 'Subheading' },
  { key: 'body', label: 'Body' },
];

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

function TableControls({ editor }: { editor: Editor }) {
  if (!editor.isActive('table')) return null;
  return (
    <div className="editor-toolbar__table-controls">
      <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row below">
        +Row
      </button>
      <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()} title="Add column right">
        +Col
      </button>
      <button type="button" onClick={() => editor.chain().focus().deleteRow().run()} title="Delete row">
        -Row
      </button>
      <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()} title="Delete column">
        -Col
      </button>
      <button type="button" onClick={() => editor.chain().focus().deleteTable().run()} title="Delete table">
        Delete table
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

  const editor = useEditor({
    extensions: [
      StarterKit,
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
        <div className="editor-toolbar__divider" />
        {btn(
          false,
          () => editor.chain().focus().setHorizontalRule().run(),
          <DividerIcon />,
          'Section divider'
        )}
        {btn(
          editor.isActive('table'),
          () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
          '⊞',
          'Insert table'
        )}
        <TableControls editor={editor} />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
