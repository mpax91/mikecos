import { useEffect, useState } from 'react';
import { platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { useAuth } from '../contexts/AuthContext';

// Shown once, the very first time MikeOS is ever opened (no login method
// registered yet) — walks through registering the first device and
// surfaces the one-time backup code before anything else in the app is
// reachable. From here on, adding more devices happens in
// Settings > Security instead (src/pages/settings/SecurityPanel.tsx).
function FirstRunSetup() {
  const { registerWebauthn, setupPin, refresh } = useAuth();
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [mode, setMode] = useState<'choose' | 'webauthn' | 'pin' | 'backup-code'>('choose');
  const [label, setLabel] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupCode, setBackupCode] = useState<string | null>(null);

  useEffect(() => {
    platformAuthenticatorIsAvailable().then(setBiometricsAvailable).catch(() => setBiometricsAvailable(false));
  }, []);

  async function handleWebauthn() {
    setBusy(true);
    setError(null);
    try {
      const code = await registerWebauthn(label.trim() || 'This device');
      if (code) setBackupCode(code);
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePin() {
    if (!/^\d{4,6}$/.test(pin)) return setError('PIN must be 4-6 digits');
    if (pin !== pinConfirm) return setError("PINs don't match");
    setBusy(true);
    setError(null);
    try {
      const code = await setupPin(pin);
      if (code) setBackupCode(code);
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (backupCode) {
    return (
      <div className="lock-screen__card">
        <h1 className="lock-screen__title">Save your backup code</h1>
        <p className="lock-screen__body">
          If you ever lose access to every device at once, this code is the only way back in. Save it somewhere safe — a password manager is a good spot — it
          will only be shown this once.
        </p>
        <div className="lock-screen__backup-code">{backupCode}</div>
        <button className="btn" onClick={() => refresh()}>
          I've saved it — continue
        </button>
      </div>
    );
  }

  if (mode === 'webauthn') {
    return (
      <div className="lock-screen__card">
        <h1 className="lock-screen__title">Set up biometric unlock</h1>
        <p className="lock-screen__body">Name this device, then follow your device's Face ID / fingerprint prompt.</p>
        <input className="lock-screen__input" placeholder="e.g. Mike's Phone" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        {error && <div className="lock-screen__error">{error}</div>}
        <div className="lock-screen__actions">
          <button className="btn btn--ghost" onClick={() => setMode('choose')} disabled={busy}>
            Back
          </button>
          <button className="btn" onClick={handleWebauthn} disabled={busy || !label.trim()}>
            {busy ? 'Waiting for device…' : 'Register device'}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'pin') {
    return (
      <div className="lock-screen__card">
        <h1 className="lock-screen__title">Set a desktop PIN</h1>
        <p className="lock-screen__body">4-6 digits. This unlocks MikeOS on this and any other desktop/laptop browser.</p>
        <input
          className="lock-screen__input"
          type="password"
          inputMode="numeric"
          placeholder="New PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
        />
        <input
          className="lock-screen__input"
          type="password"
          inputMode="numeric"
          placeholder="Confirm PIN"
          value={pinConfirm}
          onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        {error && <div className="lock-screen__error">{error}</div>}
        <div className="lock-screen__actions">
          <button className="btn btn--ghost" onClick={() => setMode('choose')} disabled={busy}>
            Back
          </button>
          <button className="btn" onClick={handlePin} disabled={busy || !pin || !pinConfirm}>
            {busy ? 'Saving…' : 'Set PIN'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lock-screen__card">
      <h1 className="lock-screen__title">Welcome to MikeOS</h1>
      <p className="lock-screen__body">Before anything else, let's lock this down. Set up at least one way in — you can add more devices later in Settings.</p>
      {biometricsAvailable && (
        <button className="btn lock-screen__option" onClick={() => setMode('webauthn')}>
          🔐 Set up Face ID / fingerprint
        </button>
      )}
      <button className="btn lock-screen__option" onClick={() => setMode('pin')}>
        🔢 Set up a desktop PIN
      </button>
    </div>
  );
}

function UnlockScreen() {
  const { status, loginWithWebauthn, loginWithPin, redeemBackupCode } = useAuth();
  const [mode, setMode] = useState<'webauthn' | 'pin' | 'backup-code'>(status?.has_webauthn ? 'webauthn' : 'pin');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newBackupCode, setNewBackupCode] = useState<string | null>(null);

  async function handleWebauthn() {
    setBusy(true);
    setError(null);
    try {
      await loginWithWebauthn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginWithPin(pin);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  async function handleBackupCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fresh = await redeemBackupCode(code.trim());
      setNewBackupCode(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (newBackupCode) {
    return (
      <div className="lock-screen__card">
        <h1 className="lock-screen__title">You're back in</h1>
        <p className="lock-screen__body">
          That backup code is now used up — here's your new one. Save it somewhere safe, then head to Settings → Security to register a replacement device or
          reset your PIN.
        </p>
        <div className="lock-screen__backup-code">{newBackupCode}</div>
      </div>
    );
  }

  return (
    <div className="lock-screen__card">
      <h1 className="lock-screen__title">MikeOS is locked</h1>

      {mode === 'webauthn' && (
        <>
          <p className="lock-screen__body">Unlock with Face ID, Touch ID, or your fingerprint.</p>
          {error && <div className="lock-screen__error">{error}</div>}
          <button className="btn lock-screen__option" onClick={handleWebauthn} disabled={busy}>
            {busy ? 'Waiting for device…' : '🔐 Unlock'}
          </button>
        </>
      )}

      {mode === 'pin' && (
        <form onSubmit={handlePin}>
          <p className="lock-screen__body">Enter your PIN.</p>
          <input
            className="lock-screen__input"
            type="password"
            inputMode="numeric"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          {error && <div className="lock-screen__error">{error}</div>}
          <button className="btn lock-screen__option" type="submit" disabled={busy || !pin}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      )}

      {mode === 'backup-code' && (
        <form onSubmit={handleBackupCode}>
          <p className="lock-screen__body">Enter your backup code (it will be replaced with a new one once used).</p>
          <input
            className="lock-screen__input"
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoFocus
          />
          {error && <div className="lock-screen__error">{error}</div>}
          <button className="btn lock-screen__option" type="submit" disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Redeem code'}
          </button>
        </form>
      )}

      <div className="lock-screen__switch">
        {mode !== 'webauthn' && status?.has_webauthn && (
          <button className="btn--link" onClick={() => setMode('webauthn')}>
            Use biometrics instead
          </button>
        )}
        {mode !== 'pin' && status?.has_pin && (
          <button className="btn--link" onClick={() => setMode('pin')}>
            Use PIN instead
          </button>
        )}
        {mode !== 'backup-code' && (
          <button className="btn--link" onClick={() => setMode('backup-code')}>
            Use backup code
          </button>
        )}
      </div>
    </div>
  );
}

export function LockScreen({ phase }: { phase: 'setup' | 'locked' }) {
  return (
    <div className="lock-screen">
      {phase === 'setup' ? <FirstRunSetup /> : <UnlockScreen />}
    </div>
  );
}
