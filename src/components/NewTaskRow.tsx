import { useState } from 'react';

/** Always-present blank row at the end of a Tasks section. Typing + Enter
 * creates the task and immediately clears itself for the next one. */
export function NewTaskRow({ onCreate }: { onCreate: (title: string) => void }) {
  const [value, setValue] = useState('');

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setValue('');
  }

  return (
    <div className="task-row task-row--new">
      <input type="checkbox" disabled className="task-row__checkbox" />
      <input
        className="task-row__input"
        placeholder="New Task"
        value={value}
        onChange={(e) => setValue(e.target.value)}
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
