/** Section switcher for dashboards (Mike, 2026-10-11): a row of pills on
 * desktop, a single dropdown on phones (≤640px) so it never wraps onto two
 * rows or scrolls sideways. Both are rendered; CSS shows one. */
export function SectionPicker<K extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
  /** Accessible name, e.g. "Source". */
  label: string;
  className?: string;
}) {
  return (
    <div className={`section-picker${className ? ` ${className}` : ''}`}>
      <div className="section-picker__pills" role="tablist" aria-label={label}>
        {options.map(([k, text]) => (
          <button key={k} type="button" role="tab" aria-selected={value === k} className={`btn btn--sm${value === k ? ' is-active' : ' btn--ghost'}`} onClick={() => onChange(k)}>
            {text}
          </button>
        ))}
      </div>
      <select className="section-picker__select" value={value} onChange={(e) => onChange(e.target.value as K)} aria-label={label}>
        {options.map(([k, text]) => (
          <option key={k} value={k}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}
