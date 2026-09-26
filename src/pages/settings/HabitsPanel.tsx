import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Habit, HabitDirection } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { TrashIcon } from '../../components/icons';

interface HabitFormState {
  name: string;
  icon: string;
  unit: string;
  targetValue: string;
  direction: HabitDirection;
}

const EMPTY_FORM: HabitFormState = { name: '', icon: '', unit: '', targetValue: '', direction: 'build' };

function formFromHabit(h: Habit): HabitFormState {
  return {
    name: h.name,
    icon: h.icon ?? '',
    unit: h.unit ?? '',
    targetValue: h.target_value != null ? String(h.target_value) : '',
    direction: h.direction,
  };
}

/** Settings' management screen for habit definitions — name, icon, unit,
 * optional target, and direction (whether less is the goal, e.g. something
 * you're cutting down, or more is, the default). This is the only place
 * habits get created or edited now; the Habits capture page (Capture →
 * Habits) only logs against what's set up here, and Journal's per-day
 * numbers are read-only against the same list — same division
 * WalletCategoriesPanel draws for Wallet's category picklist. Archiving
 * (rather than deleting) is the default way to retire one, since deleting
 * drops its whole logged history; deletion is still offered but confirmed
 * separately for that reason. */
export function HabitsPanel() {
  const [habits, setHabits] = useState<Habit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Habit | null>(null);
  const [form, setForm] = useState<HabitFormState>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<Habit | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  function load() {
    api
      .listHabits(true)
      .then((res) => {
        setHabits(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  function openAdd() {
    setForm(EMPTY_FORM);
    setSaveError(null);
    setAdding(true);
  }

  function openEdit(h: Habit) {
    setForm(formFromHabit(h));
    setSaveError(null);
    setEditing(h);
  }

  async function handleAdd() {
    const name = form.name.trim();
    if (!name) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createHabit(name, {
        icon: form.icon.trim() || null,
        unit: form.unit.trim() || null,
        targetValue: form.targetValue.trim() ? Number(form.targetValue) : null,
        direction: form.direction,
      });
      setAdding(false);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit() {
    if (!editing) return;
    const name = form.name.trim();
    if (!name) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateHabit(editing.id, {
        name,
        icon: form.icon.trim() || null,
        unit: form.unit.trim() || null,
        target_value: form.targetValue.trim() ? Number(form.targetValue) : null,
        direction: form.direction,
      });
      setEditing(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(h: Habit) {
    setHabits((prev) => (prev ? prev.map((x) => (x.id === h.id ? { ...x, active: h.active ? 0 : 1 } : x)) : prev));
    await api.updateHabit(h.id, { active: h.active ? 0 : 1 });
  }

  async function handleDelete(h: Habit) {
    setHabits((prev) => (prev ? prev.filter((x) => x.id !== h.id) : prev));
    await api.deleteHabit(h.id);
    setDeleting(null);
  }

  async function move(h: Habit, dir: -1 | 1) {
    if (!habits) return;
    const visible = habits.filter((x) => showArchived || x.active);
    const i = visible.findIndex((x) => x.id === h.id);
    const j = i + dir;
    if (j < 0 || j >= visible.length) return;
    const other = visible[j];
    setReordering(true);
    try {
      await Promise.all([api.updateHabit(h.id, { position: other.position }), api.updateHabit(other.id, { position: h.position })]);
      load();
    } finally {
      setReordering(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load habits: {error}</div>;
  if (!habits) return <div className="empty-state">Loading…</div>;

  const visible = habits.filter((h) => showArchived || h.active);

  function renderForm() {
    return (
      <>
        <div className="settings-page__form-row">
          <input autoFocus placeholder="Habit name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <input
            placeholder="Icon (emoji, optional)"
            value={form.icon}
            maxLength={4}
            style={{ maxWidth: 120 }}
            onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
          />
        </div>
        <div className="settings-page__form-row">
          <input placeholder="Unit (optional, e.g. glasses)" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
          <input
            placeholder="Target (optional)"
            type="number"
            value={form.targetValue}
            onChange={(e) => setForm((f) => ({ ...f, targetValue: e.target.value }))}
          />
        </div>
        <div className="settings-page__form-row">
          <label className="settings-page__direction-choice">
            <input
              type="radio"
              name="habit-direction"
              checked={form.direction === 'build'}
              onChange={() => setForm((f) => ({ ...f, direction: 'build' }))}
            />
            Build up — more is better
          </label>
          <label className="settings-page__direction-choice">
            <input
              type="radio"
              name="habit-direction"
              checked={form.direction === 'reduce'}
              onChange={() => setForm((f) => ({ ...f, direction: 'reduce' }))}
            />
            Cut down — less is better
          </label>
        </div>
        {saveError && <div className="settings-page__rrule-error">{saveError}</div>}
      </>
    );
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Habits</h2>
        <button className="btn" onClick={openAdd}>
          + Add Habit
        </button>
      </div>
      <p className="settings-page__section-hint">
        What shows up to log on the Habits page and in Journal's daily list. Name it however's meaningful to
        you — nothing about what a habit tracks is shown anywhere except this name, so a discreet name works
        just as well as a literal one. "Cut down" habits get comparisons and streaks that treat a lower number
        as the win; "build up" is the usual more-is-better habit.
      </p>

      <label className="settings-page__checkbox-row">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Show archived
      </label>

      {visible.length === 0 ? (
        <div className="empty-state">No habits yet — add your first one.</div>
      ) : (
        <div className="manage-list">
          {visible.map((h, i) => (
            <div className="manage-row" key={h.id}>
              <div className="manage-row__move">
                <button type="button" disabled={i === 0 || reordering} onClick={() => move(h, -1)} title="Move up">
                  ▲
                </button>
                <button type="button" disabled={i === visible.length - 1 || reordering} onClick={() => move(h, 1)} title="Move down">
                  ▼
                </button>
              </div>
              <div className="manage-row__body" onClick={() => openEdit(h)}>
                <div className="manage-row__title">
                  {h.icon ? `${h.icon} ` : ''}
                  {h.name}
                  {!h.active && <span className="settings-page__archived-tag"> · archived</span>}
                </div>
                <div className="settings-page__section-hint" style={{ margin: 0 }}>
                  {h.direction === 'reduce' ? 'Cutting down' : 'Building up'}
                  {h.target_value != null ? ` · target ${h.target_value}${h.unit ? ` ${h.unit}` : ''}` : ''}
                </div>
              </div>
              <div className="manage-row__actions">
                <button type="button" onClick={() => toggleActive(h)} title={h.active ? 'Archive' : 'Restore'}>
                  {h.active ? '📦' : '↩︎'}
                </button>
                <button type="button" onClick={() => openEdit(h)} title="Edit">
                  ✎
                </button>
                <button type="button" onClick={() => setDeleting(h)} title="Delete">
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal title="Add Habit" onClose={() => setAdding(false)}>
          {renderForm()}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleAdd} disabled={!form.name.trim() || saving}>
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit "${editing.name}"`} onClose={() => setEditing(null)}>
          {renderForm()}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleEdit} disabled={!form.name.trim() || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Delete this habit?"
          body={`"${deleting.name}" and every logged day for it will be permanently deleted. Archive it instead (the 📦 button) if you just want it off your active list.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
