import { useEffect, useState } from 'react';
import { platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from '../../api/client';
import type { AuthCredentialSummary } from '../../api/types';
import { useAuth } from '../../contexts/AuthContext';
import { ConfirmModal } from '../../components/ConfirmModal';

function formatWhen(iso: string | null): string {
  if (!iso) return 'Never used';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Settings → Security. Manage what's registered (add another phone/tablet,
 * change the desktop PIN, remove a lost device) once the app is already
 * locked down — first-time setup itself happens on the lock screen
 * (src/components/LockScreen.tsx), not here. */
export function SecurityPanel() {
  const { registerWebauthn, setupPin, logout } = useAuth();
  const [credentials, setCredentials] = useState<AuthCredentialSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);

  const [addingDevice, setAddingDevice] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [changingPin, setChangingPin] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');

  const [deleting, setDeleting] = useState<AuthCredentialSummary | null>(null);
  const [revealedBackupCode, setRevealedBackupCode] = useState<string | null>(null);

  function load() {
    api
      .listAuthCredentials()
      .then((rows) => {
        setCredentials(rows);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
    platformAuthenticatorIsAvailable().then(setBiometricsAvailable).catch(() => setBiometricsAvailable(false));
  }, []);

  async function handleAddDevice() {
    setBusy(true);
    setFormError(null);
    try {
      await registerWebauthn(newLabel.trim() || 'New device');
      setAddingDevice(false);
      setNewLabel('');
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleChangePin() {
    if (!/^\d{4,6}$/.test(newPin)) return setFormError('PIN must be 4-6 digits');
    if (newPin !== newPinConfirm) return setFormError("PINs don't match");
    setBusy(true);
    setFormError(null);
    try {
      await setupPin(newPin);
      setChangingPin(false);
      setNewPin('');
      setNewPinConfirm('');
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await api.deleteAuthCredential(deleting.id);
      setDeleting(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(null);
    }
  }

  async function handleRegenerateBackupCode() {
    try {
      const res = await api.regenerateBackupCode();
      setRevealedBackupCode(res.backup_code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!credentials) return <div style={{ color: 'var(--color-muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Security</h2>
      <p style={{ fontSize: 13, color: 'var(--color-muted)', margin: '0 0 20px', maxWidth: 520 }}>
        Everything in MikeOS is locked behind this — biometrics on phones/tablets, a PIN on desktop. Sessions last about a week before you're asked again.
      </p>
      {error && <div className="lock-screen__error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="security-panel__list">
        {credentials.map((cred) => (
          <div key={cred.id} className="security-panel__row">
            <div>
              <div className="security-panel__row-label">
                {cred.type === 'webauthn' ? '🔐' : '🔢'} {cred.device_label}
              </div>
              <div className="security-panel__row-meta">
                {cred.type === 'webauthn' ? 'Biometric device' : 'PIN'} · Added {formatWhen(cred.created_at)} · {formatWhen(cred.last_used_at)}
              </div>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => setDeleting(cred)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="security-panel__actions">
        {biometricsAvailable && !addingDevice && (
          <button className="btn btn--ghost" onClick={() => setAddingDevice(true)}>
            + Register this device
          </button>
        )}
        {!changingPin && (
          <button className="btn btn--ghost" onClick={() => setChangingPin(true)}>
            {credentials.some((c) => c.type === 'pin') ? 'Change desktop PIN' : 'Set up a desktop PIN'}
          </button>
        )}
        <button className="btn btn--ghost" onClick={handleRegenerateBackupCode}>
          Regenerate backup code
        </button>
        <button className="btn btn--ghost" onClick={() => logout()}>
          Log out
        </button>
      </div>

      {addingDevice && (
        <div className="security-panel__form">
          <input className="lock-screen__input" placeholder="Device name (e.g. Mike's Tablet)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} autoFocus />
          {formError && <div className="lock-screen__error">{formError}</div>}
          <div className="modal__actions">
            <button
              className="btn btn--ghost"
              onClick={() => {
                setAddingDevice(false);
                setFormError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn" onClick={handleAddDevice} disabled={busy || !newLabel.trim()}>
              {busy ? 'Waiting for device…' : 'Register'}
            </button>
          </div>
        </div>
      )}

      {changingPin && (
        <div className="security-panel__form">
          <input
            className="lock-screen__input"
            type="password"
            inputMode="numeric"
            placeholder="New PIN"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          <input
            className="lock-screen__input"
            type="password"
            inputMode="numeric"
            placeholder="Confirm PIN"
            value={newPinConfirm}
            onChange={(e) => setNewPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          {formError && <div className="lock-screen__error">{formError}</div>}
          <div className="modal__actions">
            <button
              className="btn btn--ghost"
              onClick={() => {
                setChangingPin(false);
                setFormError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn" onClick={handleChangePin} disabled={busy || !newPin || !newPinConfirm}>
              {busy ? 'Saving…' : 'Save PIN'}
            </button>
          </div>
        </div>
      )}

      {revealedBackupCode && (
        <div className="security-panel__form">
          <p style={{ fontSize: 13, margin: '0 0 8px' }}>Your previous backup code is now invalid. Save this new one somewhere safe — it won't be shown again.</p>
          <div className="lock-screen__backup-code">{revealedBackupCode}</div>
          <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => setRevealedBackupCode(null)}>
            Done
          </button>
        </div>
      )}

      {deleting && (
        <ConfirmModal
          title="Remove this login method?"
          body={`"${deleting.device_label}" will no longer be able to unlock MikeOS. Make sure at least one other device or your PIN still works before removing this.`}
          confirmLabel="Remove"
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
