import { useState } from 'react';

/** Always-present blank row at the end of a List's items. Typing + Enter
 * adds one item, same as NewTaskRow — but pasting multiple lines (e.g. a
 * grocery list copied from a text message) splits on newlines and creates
 * one item per non-blank line in a single request, instead of just
 * dumping the whole blob into one item's title. */
export function NewListItemRow({ onCreate, onCreateMany }: { onCreate: (title: string) => void; onCreateMany: (titles: string[]) => void }) {
  const [value, setValue] = useState('');

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setValue('');
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 1) {
      e.preventDefault();
      onCreateMany(lines);
    }
    // A single-line paste falls through to the default behavior (lands in
    // the input, same as typing) so it still composes with whatever else
    // Mike was about to add before pressing Enter.
  }

  return (
    <div className="task-row task-row--new">
      <input type="checkbox" disabled className="task-row__checkbox" />
      <input
        className="task-row__input"
        placeholder="New item — paste multiple lines to add them all at once"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        onBlur={submit}
      />
    </div>
  );
}
