import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ProjectListItem, RecurringTaskDefinition } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';

function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface FormState {
  id: string | null; // null while creating
  title: string;
  project_id: string | null;
  rrule: string;
  dtstart: string;
  active: boolean;
}

function blankForm(): FormState {
  return { id: null, title: '', project_id: null, rrule: '', dtstart: todayLocalISO(), active: true };
}

/** Recurring Tasks — the home for mirroring recurring chores from TickTick
 * into MikeOS (per Mike's own framing). Definitions here describe the
 * repeating rule; the worker spawns the actual task instances lazily as
 * they come due (see GET /api/today), one outstanding instance at a time. */
export function RecurringTasksPanel() {
  const [definitions, setDefinitions] = useState<RecurringTaskDefinition[] | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null); // non-null = modal open
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<RecurringTaskDefinition | null>(null);

  function load() {
    api.listRecurring().then(setDefinitions).catch((e) => setError(String(e)));
    api.listProjects().then(setProjects).catch(() => setProjects([]));
  }

  useEffect(() => {
    load();
  }, []);

  // Live "every week on Monday"-style preview as Mike types a raw RRULE —
  // debounced so it's not re-parsing on every keystroke, and re-runs
  // whenever dtstart changes too since the weekday/month anchor can shift
  // what the rule means in edge cases (e.g. BYSETPOS-style rules).
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
    setForm({
      id: def.id,
      title: def.title,
      project_id: def.project_id,
      rrule: def.rrule,
      dtstart: def.dtstart,
      active: def.active === 1,
    });
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
  }

  async function handleSave() {
    if (!form) return;
    const title = form.title.trim();
    const rrule = form.rrule.trim();
    if (!title || !rrule || !form.dtstart) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = { title, project_id: form.project_id, rrule, dtstart: form.dtstart, active: form.active };
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
  if (!definitions || !projects) return <div className="empty-state">Loading…</div>;

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
        planner each time one comes due, and won't spawn the next one until the last is done.
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
                <div className="settings-page__recurring-meta">
                  {def.rrule}
                  {def.project_title ? ` · ${def.project_title}` : ''}
                </div>
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

          <label className="settings-page__field-label">Project (optional)</label>
          <select value={form.project_id ?? ''} onChange={(e) => setForm({ ...form, project_id: e.target.value || null })}>
            <option value="">No project (standalone)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>

          <label className="settings-page__field-label">Starts on</label>
          <input type="date" value={form.dtstart} onChange={(e) => setForm({ ...form, dtstart: e.target.value })} />

          <label className="settings-page__field-label">Repeats (RRULE)</label>
          <input
            placeholder="FREQ=WEEKLY;BYDAY=MO"
            value={form.rrule}
            onChange={(e) => setForm({ ...form, rrule: e.target.value })}
            style={{ fontFamily: 'monospace' }}
          />
          {preview && <div className="settings-page__rrule-preview">↳ {preview}</div>}
          {previewError && <div className="settings-page__rrule-error">{previewError}</div>}

          <label className="settings-page__checkbox-row">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active
          </label>

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
