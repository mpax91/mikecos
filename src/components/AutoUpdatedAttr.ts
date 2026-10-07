import { Extension } from '@tiptap/core';

/** Marks note blocks that Statements refreshes nightly (the owned sections
 * of an auto "Account Details" / "Tax Items" note — see
 * worker/src/statements/engine.ts syncAutoNote). Rendered as data-auto so
 * CSS can tint them while editing. Not kept on split, so a new paragraph
 * Mike starts after an auto block is his, unmarked. */
export const AutoUpdatedAttr = Extension.create({
  name: 'autoUpdated',
  addGlobalAttributes() {
    return [
      {
        types: ['heading', 'paragraph', 'bulletList', 'table', 'tableCell', 'tableHeader'],
        attributes: {
          autoUpdated: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => (el.getAttribute('data-auto') === 'true' ? true : null),
            renderHTML: (attrs) => (attrs.autoUpdated ? { 'data-auto': 'true' } : {}),
          },
        },
      },
    ];
  },
});
