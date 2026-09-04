import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { api } from '../api/client';

interface AttachmentAttrs {
  url: string;
  filename: string;
  mimeType: string;
  r2Key: string;
}

function AttachmentView({ node, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as AttachmentAttrs;
  const { url, filename, mimeType, r2Key } = attrs;
  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  function handleDelete() {
    deleteNode();
    if (r2Key) api.deleteFileKey(r2Key).catch(() => {});
  }

  return (
    <NodeViewWrapper className="note-attachment" contentEditable={false} data-drag-handle>
      <div className="note-attachment__bar">
        <span className="note-attachment__name">{filename}</span>
        <div className="note-attachment__actions">
          <button
            type="button"
            className="note-attachment__action"
            title="Download"
            onClick={() => window.open(`${url}?download=1`, '_blank')}
          >
            ⬇
          </button>
          <button type="button" className="note-attachment__action" title="Remove" onClick={handleDelete}>
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
