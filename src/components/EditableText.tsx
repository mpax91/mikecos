import { useEffect, useRef, useState } from 'react';

/** Click-to-edit text. Renders as static text until clicked, then becomes an
 * input/textarea and saves (debounced) on change, committing on blur. */
export function EditableText({
  value,
  onSave,
  placeholder,
  as = 'input',
  className,
  displayClassName,
}: {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  as?: 'input' | 'textarea';
  className?: string;
  displayClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  function scheduleSave(next: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onSave(next), 500);
  }

  function commit() {
    setEditing(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    onSave(draft);
  }

  if (!editing) {
    const isEmpty = !value;
    return (
      <div
        className={`editable-text__display${displayClassName ? ` ${displayClassName}` : ''}${
          isEmpty ? ' is-placeholder' : ''
        }`}
        onClick={() => setEditing(true)}
        title="Click to edit"
      >
        {isEmpty ? placeholder : value}
      </div>
    );
  }

  const commonProps = {
    ref,
    className,
    value: draft,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      scheduleSave(e.target.value);
    },
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && as === 'input') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        setDraft(value);
        setEditing(false);
      }
    },
  };

  return as === 'textarea' ? <textarea {...commonProps} /> : <input {...commonProps} />;
}
