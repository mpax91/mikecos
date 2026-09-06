import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { normalizeUrl } from '../api/client';

interface LinkPreviewAttrs {
  url: string;
  title: string | null;
  image: string | null;
  domain: string | null;
}

function LinkPreviewView({ node, deleteNode }: NodeViewProps) {
  const { url, title, image, domain } = node.attrs as LinkPreviewAttrs;

  return (
    <NodeViewWrapper className="link-preview-node" contentEditable={false} data-drag-handle>
      <a
        className="link-preview-node__card card"
        href={normalizeUrl(url)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {image && (
          <div className="link-preview-node__image">
            <img src={image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          </div>
        )}
        <div className="link-preview-node__body">
          <div className="link-preview-node__title">{title || url}</div>
          <div className="link-preview-node__domain">{domain || url}</div>
        </div>
      </a>
      <button
        type="button"
        className="link-preview-node__remove"
        title="Remove"
        onClick={(e) => {
          e.stopPropagation();
          deleteNode();
        }}
      >
        ✕
      </button>
    </NodeViewWrapper>
  );
}

export const LinkPreview = Node.create({
  name: 'linkPreview',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: null },
      title: { default: null },
      image: { default: null },
      domain: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-link-preview]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-link-preview': '' }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkPreviewView);
  },
});
