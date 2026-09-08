import { useState } from 'react';
import { Modal } from './Modal';
import { WEEKDAY_CODES, WEEKDAY_SHORT_LABELS, type CustomFreqUnit, type CustomRecurrenceRule } from '../utils/recurrence';

const UNIT_LABELS: Record<CustomFreqUnit, { singular: string; plural: string }> = {
  day: { singular: 'day', plural: 'days' },
  week: { singular: 'week', plural: 'weeks' },
  month: { singular: 'month', plural: 'months' },
  year: { singular: 'year', plural: 'years' },
};

/** Google Calendar's own "Custom recurrence" popup, reproduced for the
 * Recurring Tasks form's 'custom' preset — Repeat every N ___, which
 * weekdays (only when the unit is weeks), and when it ends. Produces a
 * plain RRULE string on Done via customRuleToRrule; the caller owns
 * whether that gets saved (Cancel just closes without calling onDone). */
export function CustomRecurrenceModal({
  initial,
  dtstart,
  onDone,
  onCancel,
}: {
  initial: CustomRecurrenceRule;
  dtstart: string;
  onDone: (rule: CustomRecurrenceRule) => void;
  onCancel: () => void;
}) {
  const [interval, setInterval] = useState(initial.interval);
  const [unit, setUnit] = useState<CustomFreqUnit>(initial.unit);
  const [byDay, setByDay] = useState<string[]>(initial.byDay);
  const [endsType, setEndsType] = useState<CustomRecurrenceRule['ends']['type']>(initial.ends.type);
  const [endsOnDate, setEndsOnDate] = useState(initial.ends.type === 'on' ? initial.ends.date : dtstart);
  const [endsAfterCount, setEndsAfterCount] = useState(initial.ends.type === 'after' ? initial.ends.count : 13);

  function toggleDay(code: string) {
    setByDay((prev) => (prev.includes(code) ? prev.filter((d) => d !== code) : [...prev, code]));
  }

  function handleDone() {
    const ends: CustomRecurrenceRule['ends'] =
      endsType === 'on' ? { type: 'on', date: endsOnDate } : endsType === 'after' ? { type: 'after', count: endsAfterCount } : { type: 'never' };
    onDone({
      interval: Math.max(1, interval || 1),
      unit,
      byDay: unit === 'week' ? byDay : [],
      ends,
    });
  }

  const canSave = unit !== 'week' || byDay.length > 0;

  return (
    <Modal title="Custom recurrence" onClose={onCancel}>
      <div className="custom-recurrence__row">
        <span className="custom-recurrence__label">Repeat every</span>
        <input
          type="number"
          min={1}
          value={interval}
          onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 1))}
          className="custom-recurrence__interval"
        />
        <select value={unit} onChange={(e) => setUnit(e.target.value as CustomFreqUnit)} className="custom-recurrence__unit">
          {(Object.keys(UNIT_LABELS) as CustomFreqUnit[]).map((u) => (
            <option key={u} value={u}>
              {interval === 1 ? UNIT_LABELS[u].singular : UNIT_LABELS[u].plural}
            </option>
          ))}
        </select>
      </div>

      {unit === 'week' && (
        <div className="custom-recurrence__section">
          <div className="custom-recurrence__label">Repeat on</div>
          <div className="custom-recurrence__weekdays">
            {WEEKDAY_CODES.map((code, i) => (
              <button
                key={code}
                type="button"
                className={`custom-recurrence__weekday${byDay.includes(code) ? ' is-selected' : ''}`}
                onClick={() => toggleDay(code)}
              >
                {WEEKDAY_SHORT_LABELS[i]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="custom-recurrence__section">
        <div className="custom-recurrence__label">Ends</div>
        <label className="custom-recurrence__ends-option">
          <input type="radio" checked={endsType === 'never'} onChange={() => setEndsType('never')} />
          Never
        </label>
        <label className="custom-recurrence__ends-option">
          <input type="radio" checked={endsType === 'on'} onChange={() => setEndsType('on')} />
          On
          <input
            type="date"
            value={endsOnDate}
            min={dtstart}
            onChange={(e) => {
              setEndsOnDate(e.target.value);
              setEndsType('on');
            }}
            disabled={endsType !== 'on'}
            className="custom-recurrence__ends-date"
          />
        </label>
        <label className="custom-recurrence__ends-option">
          <input type="radio" checked={endsType === 'after'} onChange={() => setEndsType('after')} />
          After
          <input
            type="number"
            min={1}
            value={endsAfterCount}
            onChange={(e) => {
              setEndsAfterCount(Math.max(1, Number(e.target.value) || 1));
              setEndsType('after');
            }}
            disabled={endsType !== 'after'}
            className="custom-recurrence__ends-count"
          />
          occurrence{endsAfterCount === 1 ? '' : 's'}
        </label>
      </div>

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={handleDone} disabled={!canSave}>
          Done
        </button>
      </div>
    </Modal>
  );
}
