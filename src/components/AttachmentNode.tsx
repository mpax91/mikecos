import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { api } from '../api/client';

interface AttachmentAttrs {
  url: string;
  filename: string;
  mimeType: string;
  r2Key: string;
  /** Byte size at upload time — not shown anywhere today, but carried along
   * so converting a Jot into a Task can build a real FileMeta (which
   * requires size) for the resulting sibling file entity without a second
   * round trip to look it up. */
  size: number;
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5v8.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4.5 6.2L8 9.9l3.5-3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 12.5v1a1 1 0 001 1h10a1 1 0 001-1v-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AttachmentView({ node, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as AttachmentAttrs;
  const { url, filename, mimeType, r2Key } = attrs;
  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const kind = isImage ? 'image' : isPdf ? 'pdf' : 'generic';

  function handleDelete() {
    deleteNode();
    if (r2Key) api.deleteFileKey(r2Key).catch(() => {});
  }

  return (
    <NodeViewWrapper className={`note-attachment note-attachment--${kind}`} contentEditable={false} data-drag-handle>
      <div className="note-attachment__bar">
        <span className="note-attachment__name">{filename}</span>
        <div className="note-attachment__actions">
          <button
            type="button"
            className="note-attachment__download"
            onClick={() => window.open(`${url}?download=1`, '_blank')}
          >
            <DownloadIcon /> Download
          </button>
          <button type="button" className="note-attachment__remove" title="Remove" onClick={handleDelete}>
            ✕
          </button>
        </div>
      </div>
      {isImage ? (
        <img className="note-attachment__image" src={url} alt={filename} />
      ) : isPdf ? (
        <iframe className="note-attachment__pdf" src={url} title={filename} />
      ) : (
        <div className="note-attachment__generic">
          <span className="note-attachment__generic-icon">📎</span> {filename}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: null },
      filename: { default: null },
      mimeType: { default: null },
      r2Key: { default: null },
      size: { default: 0 },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-attachment]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-attachment': '' }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView);
  },
});
