import { useState } from 'react';
import { RANGE_LABEL, type RangeKey, type DateRange, resolveRange } from '../../utils/dateRange';

const SELECT_LABEL: Record<RangeKey, string> = { '7d': 'Last 7 Days', '28d': 'Last 28 Days', '90d': 'Last 90 Days', ytd: 'Year to Date', '1y': 'Last 12 Months', all: 'All Time', custom: 'Custom…' };

/** Date range control for dashboards: presets + Custom. Pills on desktop, a
 * dropdown on phones; Custom opens two date fields. */
export function RangePicker({
  value,
  onChange,
  today,
  earliest,
  presets = ['7d', '28d', '90d', 'ytd', '1y', 'all'],
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  today: string;
  earliest: string;
  presets?: RangeKey[];
}) {
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const keys: RangeKey[] = [...presets, 'custom'];
  const pick = (k: RangeKey) => {
    if (k === 'custom') onChange({ key: 'custom', from: value.from, to: value.to, label: 'Custom' });
    else onChange(resolveRange(k, today, earliest));
  };
  return (
    <div className="range-picker">
      <div className="section-picker__pills range-picker__pills" role="tablist" aria-label="Date range">
        {keys.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={value.key === k} className={`btn btn--sm${value.key === k ? ' is-active' : ' btn--ghost'}`} onClick={() => pick(k)}>
            {RANGE_LABEL[k]}
          </button>
        ))}
      </div>
      <select className="section-picker__select range-picker__select" value={value.key} onChange={(e) => pick(e.target.value as RangeKey)} aria-label="Date range">
        {keys.map((k) => (
          <option key={k} value={k}>
            {SELECT_LABEL[k]}
          </option>
        ))}
      </select>
      {value.key === 'custom' && (
        <div className="range-picker__custom">
          <input type="date" value={from} min={earliest} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span>–</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          <button type="button" className="btn btn--sm" disabled={!from || !to || from > to} onClick={() => onChange({ key: 'custom', from, to, label: 'Custom' })}>
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
