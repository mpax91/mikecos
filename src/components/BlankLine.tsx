import { useState } from 'react';

/** One empty ruled line in a planner page — the paper-planner counterpart to
 * a "quick add" input. A day always shows a fixed run of these below its
 * real tasks (see BLANK_LINES_PER_DAY in TodayPage/WeekPage) rather than one
 * single input, on the theory that a page of blank lines invites you to
 * actually fill the day the way a real notebook does. Typing into one and
 * submitting turns it into a real task and the line goes back to blank —
 * it doesn't disappear, so the run of lines stays a constant, inviting
 * presence rather than shrinking away. */
export function BlankLine({
  onSubmit,
  placeholder,
}: {
  onSubmit: (title: string) => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');

  function submit() {
    const title = value.trim();
    if (!title) return;
    setValue('');
    onSubmit(title);
  }

  return (
    <input
      className="blank-line"
      placeholder={placeholder}
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
  );
}
