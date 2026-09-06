import { useEditor, EditorContent } from '@tiptap/react';
import { noteExtensions } from './NoteEditor';

/** Read-only render of a Jot's (or Note's) Tiptap content — used on Jot
 * cards so images/PDFs/link-preview cards show as real previews, exactly as
 * they'd look while editing, without needing a second, hand-rolled renderer
 * that could drift from the real editor over time. */
export function JotBody({ content }: { content: string | null }) {
  const editor = useEditor({
    editable: false,
    extensions: noteExtensions(),
    content: content ? JSON.parse(content) : '',
  });

  if (!editor) return null;
  // Wrapped in the same `.note-editor`/`.note-editor__content-area` classes
  // NoteEditor itself uses, so every one of its ProseMirror content rules
  // (paragraph spacing, checklists, tables, attachment/link-preview cards)
  // applies identically here — a card never looks different from how the
  // same content looks while actually being edited.
  return (
    <div className="note-editor jot-card__note-editor">
      <div className="note-editor__content-area">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
