import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Mention } from '@tiptap/extension-mention';
import { useEffect, useRef } from 'react';

const AUTOSAVE_DEBOUNCE_MS = 800;

export function NoteEditor({
  content,
  onSave,
}: {
  content: string | null;
  onSave: (json: string) => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        onSave(JSON.stringify(editor.getJSON()));
      }, AUTOSAVE_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  if (!editor) return null;

  return (
    <div className="note-editor">
      {editor && (
        <BubbleMenu editor={editor} className="note-editor__bubble">
          <button
            type="button"
            className={editor.isActive('bold') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            B
          </button>
          <button
            type="button"
            className={editor.isActive('italic') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            I
          </button>
          <button
            type="button"
            className={editor.isActive('strike') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            S
          </button>
          <button
            type="button"
            className={editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H
          </button>
          <button
            type="button"
            className={editor.isActive('bulletList') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            •
          </button>
          <button
            type="button"
            className={editor.isActive('orderedList') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            1.
          </button>
          <button
            type="button"
            className={editor.isActive('blockquote') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            "
          </button>
          <button
            type="button"
            className={editor.isActive('taskList') ? 'is-active' : ''}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          >
            ☑
          </button>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
