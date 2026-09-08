import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { RecurringTaskDefinition } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { CustomRecurrenceModal } from '../../components/CustomRecurrenceModal';
import {
  RECURRENCE_PRESETS,
  customRuleToRrule,
  defaultCustomRule,
  describeCustomRrule,
  detectPreset,
  presetLabel,
  presetToRrule,
  rruleToCustomRule,
  type CustomRecurrenceRule,
  type RecurrencePreset,
} from '../../utils/recurrence';

function recurrenceRowLabel(rrule: string, dtstart: string): string {
  const preset = detectPreset(rrule, dtstart);
  return preset === 'custom' ? describeCustomRrule(rrule, dtstart) : presetLabel(preset, dtstart);
}

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface FormState {
  id: string | null; // null while creating
  title: string;
  dtstart: string;
  preset: RecurrencePreset;
  rrule: string; // the actual RRULE that gets saved — computed from preset+dtstart, or typed directly when preset is 'custom'
}

function blankForm(): FormState {
  const dtstart = todayLocalISO();
  return { id: null, title: '', dtstart, preset: 'weekly', rrule: presetToRrule('weekly', dtstart) };
}

/** Recurring Tasks — the home for mirroring recurring chores from TickTick
 * into MikeOS (per Mike's own framing). Definitions here describe the
 * repeating rule; the worker spawns the actual task instances lazily as
 * they come due (see GET /api/today), one outstanding instance at a time.
 * Pausing/resuming a definition is the list's own ●/○ toggle — there's
 * deliberately no separate "Active" control in the form, since that would
 * just be the same switch in two places. */
export function RecurringTasksPanel() {
  const [definitions, setDefinitions] = useState<RecurringTaskDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null); // non-null = modal open
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<RecurringTaskDefinition | null>(null);

  // Picking 'custom' from the Repeats dropdown pops up the Custom
  // recurrence dialog immediately, same as Google Calendar's own — this
  // remembers which preset was showing right before that happened, so
  // Cancelling out of the dialog without ever having a custom rule set can
  // land the dropdown back on something real instead of stranding it on
  // 'custom' with nothing behind it.
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [presetBeforeCustom, setPresetBeforeCustom] = useState<RecurrencePreset>('weekly');

  function load() {
    api.listRecurring().then(setDefinitions).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  // Live "every week on Monday"-style preview of whatever RRULE is about to
  // be saved — mainly there for the 'custom' escape hatch (where Mike is
  // typing raw RRULE syntax and wants to sanity-check it), but shown for
  // the presets too as a plain confirmation of what was picked.
  useEffect(() => {
    if (!form || !form.rrule.trim() || !form.dtstart) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const rrule = form.rrule.trim();
    const dtstart = form.dtstart;
    const timer = window.setTimeout(() => {
      api
        .previewRrule(rrule, dtstart)
        .then((res) => {
          setPreview(res.text);
          setPreviewError(null);
        })
        .catch(() => {
          setPreview(null);
          setPreviewError("Can't parse that RRULE — check the syntax (e.g. FREQ=WEEKLY;BYDAY=MO)");
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [form?.rrule, form?.dtstart]);

  function openCreate() {
    setForm(blankForm());
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
  }

  function openEdit(def: RecurringTaskDefinition) {
    const preset = detectPreset(def.rrule, def.dtstart);
    setForm({ id: def.id, title: def.title, dtstart: def.dtstart, preset, rrule: def.rrule });
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
  }

  // Changing the preset recomputes the RRULE automatically — the weekday/
  // month-day a preset means is always derived from dtstart, so changing
  // either wipes out any stale rrule from before. Picking 'custom' instead
  // opens the Custom recurrence dialog right away (see customModalOpen);
  // the dropdown only actually lands on 'custom' once that dialog is saved
  // with Done, matching how Google Calendar's own dropdown behaves.
  function setPreset(preset: RecurrencePreset) {
    if (preset === 'custom') {
      setPresetBeforeCustom(form?.preset ?? 'weekly');
      setCustomModalOpen(true);
      setForm((prev) => (prev ? { ...prev, preset: 'custom' } : prev));
      return;
    }
    setForm((prev) => (prev ? { ...prev, preset, rrule: presetToRrule(preset, prev.dtstart) } : prev));
  }

  function openCustomModalForEdit() {
    setPresetBeforeCustom('custom');
    setCustomModalOpen(true);
  }

  function handleCustomDone(rule: CustomRecurrenceRule) {
    setForm((prev) => (prev ? { ...prev, preset: 'custom', rrule: customRuleToRrule(rule) } : prev));
    setCustomModalOpen(false);
  }

  // Cancelling the dialog before it's ever been saved with Done leaves
  // nothing custom behind — snap the dropdown back to whatever preset was
  // showing beforehand rather than stranding it on 'custom' with no rule.
  // Reopening the dialog to tweak an already-custom rule just closes it
  // unchanged instead (presetBeforeCustom is 'custom' in that case).
  function handleCustomCancel() {
    setCustomModalOpen(false);
    if (presetBeforeCustom !== 'custom') {
      setForm((prev) => (prev ? { ...prev, preset: presetBeforeCustom, rrule: presetToRrule(presetBeforeCustom, prev.dtstart) } : prev));
    }
  }

  function setDtstart(dtstart: string) {
    setForm((prev) => (prev ? { ...prev, dtstart, rrule: prev.preset === 'custom' ? prev.rrule : presetToRrule(prev.preset, dtstart) } : prev));
  }

  async function handleSave() {
    if (!form) return;
    const title = form.title.trim();
    const rrule = form.rrule.trim();
    if (!title || !rrule || !form.dtstart) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = { title, rrule, dtstart: form.dtstart };
      if (form.id) {
        await api.updateRecurring(form.id, payload);
      } else {
        await api.createRecurring(payload);
      }
      setForm(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(def: RecurringTaskDefinition) {
    setDefinitions((prev) => (prev ? prev.map((d) => (d.id === def.id ? { ...d, active: def.active === 1 ? 0 : 1 } : d)) : prev));
    await api.updateRecurring(def.id, { active: def.active !== 1 });
  }

  async function handleDelete(def: RecurringTaskDefinition) {
    setDefinitions((prev) => (prev ? prev.filter((d) => d.id !== def.id) : prev));
    await api.deleteRecurring(def.id);
    setDeleting(null);
  }

  if (error) return <div className="empty-state">Couldn't load recurring tasks: {error}</div>;
  if (!definitions) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Recurring Tasks</h2>
        <button className="btn" onClick={openCreate}>
          + New Recurring Task
        </button>
      </div>
      <p className="settings-page__section-hint">
        Mirror a chore that repeats on a schedule (from TickTick or anywhere else) — MikeOS will drop a new task onto the
        planner each time one comes due, and won't spawn the next one until the last is done. Click the dot next to one to
        pause or resume it.
      </p>

      {definitions.length === 0 ? (
        <div className="empty-state">No recurring tasks yet — create your first one.</div>
      ) : (
        <div className="settings-page__recurring-list card">
          {definitions.map((def) => (
            <div key={def.id} className={`settings-page__recurring-row${def.active === 1 ? '' : ' is-inactive'}`}>
              <button
                type="button"
                className="settings-page__recurring-toggle"
                title={def.active === 1 ? 'Active — click to pause' : 'Paused — click to resume'}
                onClick={() => handleToggleActive(def)}
              >
                {def.active === 1 ? '●' : '○'}
              </button>
              <div className="settings-page__recurring-main" onClick={() => openEdit(def)}>
                <div className="settings-page__recurring-title">{def.title}</div>
                <div className="settings-page__recurring-meta">{recurrenceRowLabel(def.rrule, def.dtstart)}</div>
              </div>
              <button type="button" className="settings-page__recurring-delete" title="Delete" onClick={() => setDeleting(def)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Modal title={form.id ? 'Edit Recurring Task' : 'New Recurring Task'} onClose={() => setForm(null)}>
          <input autoFocus placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />

          <label className="settings-page__field-label">Starts on</label>
          <input type="date" value={form.dtstart} onChange={(e) => setDtstart(e.target.value)} />

          <label className="settings-page__field-label">Repeats</label>
          <select value={form.preset} onChange={(e) => setPreset(e.target.value as RecurrencePreset)}>
            {RECURRENCE_PRESETS.map((p) => (
              <option key={p} value={p}>
                {presetLabel(p, form.dtstart)}
              </option>
            ))}
          </select>

          {form.preset === 'custom' && (
            <button type="button" className="settings-page__custom-recurrence-edit" onClick={openCustomModalForEdit}>
              ✎ Edit custom recurrence
            </button>
          )}
          {preview && <div className="settings-page__rrule-preview">↳ {preview}</div>}
          {previewError && <div className="settings-page__rrule-error">{previewError}</div>}

          {saveError && <div className="settings-page__rrule-error">{saveError}</div>}

          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleSave} disabled={!form.title.trim() || !form.rrule.trim() || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {customModalOpen && form && (
        <CustomRecurrenceModal
          initial={presetBeforeCustom === 'custom' ? rruleToCustomRule(form.rrule, form.dtstart) : defaultCustomRule(form.dtstart)}
          dtstart={form.dtstart}
          onDone={handleCustomDone}
          onCancel={handleCustomCancel}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete recurring task?"
          body={`"${deleting.title}" will stop spawning new tasks. Anything already on your planner from it stays put.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
