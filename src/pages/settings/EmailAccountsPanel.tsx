import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { EmailAccount } from '../../api/types';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { TrashIcon } from '../../components/icons';

interface FormState {
  label: string;
  email: string;
  appPassword: string;
  icon: string;
  iconImageKey: string | null;
  iconImageUrl: string | null;
  color: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  email: '',
  appPassword: '',
  icon: '📧',
  iconImageKey: null,
  iconImageUrl: null,
  color: '#2F4A3C',
};
// A handful of distinct icons/colors to suggest per new account, cycled by
// how many accounts already exist — mostly so Mike doesn't have to think of
// one every time, not a hard rule (both fields are freely editable).
const SUGGESTED: { icon: string; color: string }[] = [
  { icon: '📧', color: '#2F4A3C' },
  { icon: '💼', color: '#B8632F' },
  { icon: '📰', color: '#8A7B5E' },
  { icon: '🏛️', color: '#2F5A8C' },
  { icon: '✉️', color: '#7A3F8C' },
];

function formFromAccount(a: EmailAccount): FormState {
  return {
    label: a.label,
    email: a.email,
    appPassword: '',
    icon: a.icon,
    iconImageKey: a.icon_image_key,
    iconImageUrl: a.iconImageUrl,
    color: a.color,
  };
}

/** Settings' management screen for Inbox's connected mailboxes. Each
 * account authenticates via a Gmail App Password (imap.gmail.com/
 * smtp.gmail.com by default) rather than full OAuth — see the Inbox design
 * conversation this came out of. The password is write-only: once saved,
 * this screen (and the server) never shows it again, only whether one is
 * already set. "Test Connection" does a real IMAP login without syncing
 * anything, so a typo surfaces immediately instead of on the next cron
 * tick. */
export function EmailAccountsPanel() {
  const [accounts, setAccounts] = useState<EmailAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EmailAccount | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<EmailAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function load() {
    api
      .listEmailAccounts()
      .then((res) => {
        setAccounts(res);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  function openAdd() {
    const suggestion = SUGGESTED[(accounts?.length ?? 0) % SUGGESTED.length];
    setForm({ ...EMPTY_FORM, icon: suggestion.icon, color: suggestion.color });
    setSaveError(null);
    setTestResult(null);
    setAdding(true);
  }

  function openEdit(a: EmailAccount) {
    setForm(formFromAccount(a));
    setSaveError(null);
    setTestResult(null);
    setEditing(a);
  }

  async function handleAdd() {
    if (!form.label.trim() || !form.email.trim() || !form.appPassword.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createEmailAccount({
        label: form.label.trim(),
        email: form.email.trim(),
        appPassword: form.appPassword.trim(),
        icon: form.icon.trim() || undefined,
        iconImageKey: form.iconImageKey,
        color: form.color.trim() || undefined,
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
    if (!editing || !form.label.trim() || !form.email.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateEmailAccount(editing.id, {
        label: form.label.trim(),
        email: form.email.trim(),
        icon: form.icon.trim() || undefined,
        iconImageKey: form.iconImageKey,
        color: form.color.trim() || undefined,
        // Only overwrite the stored app password if a new one was typed —
        // leaving the field blank keeps the existing one.
        ...(form.appPassword.trim() ? { appPassword: form.appPassword.trim() } : {}),
      });
      setEditing(null);
      load();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleIconFile(file: File | undefined) {
    if (!file) return;
    setUploadingIcon(true);
    setUploadError(null);
    try {
      const res = await api.uploadInline(file);
      setForm((f) => ({ ...f, iconImageKey: res.r2_key, iconImageUrl: res.url }));
    } catch (e) {
      setUploadError(String(e));
    } finally {
      setUploadingIcon(false);
    }
  }

  async function toggleActive(a: EmailAccount) {
    setAccounts((prev) => (prev ? prev.map((x) => (x.id === a.id ? { ...x, active: a.active ? 0 : 1 } : x)) : prev));
    await api.updateEmailAccount(a.id, { active: !a.active });
  }

  async function handleDelete(a: EmailAccount) {
    setAccounts((prev) => (prev ? prev.filter((x) => x.id !== a.id) : prev));
    await api.deleteEmailAccount(a.id);
    setDeleting(null);
  }

  async function testConnection(id: string) {
    setTestingId(id);
    setTestResult(null);
    try {
      const res = await api.testEmailAccount(id);
      setTestResult({ id, ...res });
      load();
    } catch (e) {
      setTestResult({ id, ok: false, error: String(e) });
    } finally {
      setTestingId(null);
    }
  }

  if (error) return <div className="empty-state">Couldn't load email accounts: {error}</div>;
  if (!accounts) return <div className="empty-state">Loading…</div>;

  function renderForm(isEdit: boolean) {
    return (
      <>
        <div className="settings-page__form-row">
          <input
            autoFocus
            placeholder='Label (e.g. "Personal")'
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
          <input type="color" value={form.color} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} style={{ width: 44, padding: 2 }} />
        </div>
        <div className="settings-page__form-row settings-page__icon-row">
          {form.iconImageUrl ? (
            <img src={form.iconImageUrl} alt="" className="settings-page__icon-preview" />
          ) : (
            <span className="settings-page__icon-preview settings-page__icon-preview--emoji" style={{ color: form.color }}>
              {form.icon || '📧'}
            </span>
          )}
          <div className="settings-page__icon-controls">
            <label className="btn btn--ghost btn--sm settings-page__icon-upload">
              {uploadingIcon ? 'Uploading…' : form.iconImageUrl ? 'Replace image' : 'Upload image'}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={uploadingIcon}
                onChange={(e) => handleIconFile(e.target.files?.[0])}
              />
            </label>
            {form.iconImageUrl ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setForm((f) => ({ ...f, iconImageKey: null, iconImageUrl: null }))}
              >
                Remove image
              </button>
            ) : (
              <input
                placeholder="or type an emoji"
                value={form.icon}
                maxLength={4}
                style={{ maxWidth: 130 }}
                onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
              />
            )}
          </div>
        </div>
        {uploadError && <div className="settings-page__rrule-error">{uploadError}</div>}
        <div className="settings-page__form-row">
          <input
            placeholder="you@gmail.com"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div className="settings-page__form-row">
          <input
            placeholder={isEdit ? 'App Password (leave blank to keep current)' : 'App Password'}
            type="password"
            autoComplete="new-password"
            value={form.appPassword}
            onChange={(e) => setForm((f) => ({ ...f, appPassword: e.target.value }))}
          />
        </div>
        <p className="settings-page__section-hint" style={{ margin: '2px 0 0' }}>
          Not your regular Gmail password — generate a 16-character App Password at{' '}
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
            myaccount.google.com/apppasswords
          </a>{' '}
          (requires 2-Step Verification). For a Google Workspace address, an admin may need to confirm IMAP access is
          allowed first.
        </p>
        {saveError && <div className="settings-page__rrule-error">{saveError}</div>}
      </>
    );
  }

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Email Accounts</h2>
        <button className="btn" onClick={openAdd}>
          + Add Account
        </button>
      </div>
      <p className="settings-page__section-hint">
        Every mailbox Inbox watches. MikeOS polls each one's INBOX every couple of minutes over IMAP — no separate
        filtering happens here, so anything a Gmail filter already keeps out of your real inbox (auto-archived,
        labeled and skipped, etc.) never shows up in MikeOS either.
      </p>

      {accounts.length === 0 ? (
        <div className="empty-state">No accounts connected yet — add your first mailbox.</div>
      ) : (
        <div className="manage-list">
          {accounts.map((a) => (
            <div className="manage-row" key={a.id}>
              <div className="manage-row__body" onClick={() => openEdit(a)}>
                <div className="manage-row__title">
                  {a.iconImageUrl ? (
                    <img src={a.iconImageUrl} alt="" className="settings-page__icon-thumb" />
                  ) : (
                    <span style={{ color: a.color }}>{a.icon}</span>
                  )}{' '}
                  {a.label}
                  {!a.active && <span className="settings-page__archived-tag"> · paused</span>}
                </div>
                <div className="settings-page__section-hint" style={{ margin: 0 }}>
                  {a.email}
                  {a.last_error ? (
                    <span style={{ color: 'var(--color-accent-secondary)' }}> · {a.last_error}</span>
                  ) : a.last_synced_at ? (
                    ' · synced'
                  ) : (
                    ' · not yet synced'
                  )}
                  {testResult?.id === a.id && (
                    <span style={{ color: testResult.ok ? 'var(--color-accent)' : 'var(--color-accent-secondary)' }}>
                      {' · '}
                      {testResult.ok ? 'Connection OK' : testResult.error}
                    </span>
                  )}
                </div>
              </div>
              <div className="manage-row__actions">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    testConnection(a.id);
                  }}
                  disabled={testingId === a.id}
                  title="Test Connection"
                >
                  {testingId === a.id ? '…' : '🔌'}
                </button>
                <button type="button" onClick={() => toggleActive(a)} title={a.active ? 'Pause' : 'Resume'}>
                  {a.active ? '⏸' : '▶︎'}
                </button>
                <button type="button" onClick={() => openEdit(a)} title="Edit">
                  ✎
                </button>
                <button type="button" onClick={() => setDeleting(a)} title="Remove">
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal title="Add Email Account" onClose={() => setAdding(false)}>
          {renderForm(false)}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn" onClick={handleAdd} disabled={!form.label.trim() || !form.email.trim() || !form.appPassword.trim() || saving}>
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit "${editing.label}"`} onClose={() => setEditing(null)}>
          {renderForm(true)}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn" onClick={handleEdit} disabled={!form.label.trim() || !form.email.trim() || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          title="Remove this account?"
          body={`"${deleting.label}" will stop syncing and every message MikeOS has cached for it will be removed. Nothing happens to the real mailbox.`}
          onConfirm={() => handleDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
