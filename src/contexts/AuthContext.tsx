import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from '../api/client';
import { UNAUTHORIZED_EVENT } from '../api/client';
import type { AuthStatus } from '../api/types';

// The app has three phases, not two — "no one has ever set up a login
// method yet" is materially different from "someone's logged out": the
// first shows an unauthenticated first-run setup screen (there's nothing
// to protect yet), the second shows a lock screen that only a registered
// device or PIN can pass.
type Phase = 'loading' | 'setup' | 'locked' | 'unlocked';

interface AuthContextValue {
  phase: Phase;
  status: AuthStatus | null;
  refresh: () => Promise<void>;
  loginWithWebauthn: () => Promise<void>;
  loginWithPin: (pin: string) => Promise<void>;
  redeemBackupCode: (code: string) => Promise<string>; // resolves with the freshly-issued replacement code
  registerWebauthn: (deviceLabel: string) => Promise<string | null>; // resolves with a backup code only on first-ever setup
  setupPin: (pin: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setStatus(s);
      setPhase(!s.has_credentials ? 'setup' : s.authenticated ? 'unlocked' : 'locked');
    } catch {
      // Can't reach the API at all — nothing to unlock into either way.
      setPhase('locked');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A session that expires (or gets revoked from another device) mid-use
  // surfaces as a 401 on whatever request happened to be in flight —
  // this is the one place that gets translated back into "show the lock
  // screen" everywhere in the app, rather than every caller handling it.
  useEffect(() => {
    const onUnauthorized = () => refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  const loginWithWebauthn = useCallback(async () => {
    const { options } = await api.webauthnLoginOptions();
    const response = await startAuthentication({ optionsJSON: options });
    await api.webauthnLoginVerify(options.challenge, response);
    await refresh();
  }, [refresh]);

  const loginWithPin = useCallback(
    async (pin: string) => {
      await api.pinLogin(pin);
      await refresh();
    },
    [refresh]
  );

  const redeemBackupCode = useCallback(
    async (code: string) => {
      const res = await api.redeemBackupCode(code);
      await refresh();
      return res.backup_code;
    },
    [refresh]
  );

  const registerWebauthn = useCallback(
    async (deviceLabel: string) => {
      const { options } = await api.webauthnRegisterOptions(deviceLabel);
      const response = await startRegistration({ optionsJSON: options });
      const res = await api.webauthnRegisterVerify(deviceLabel, options.challenge, response);
      await refresh();
      return res.backup_code;
    },
    [refresh]
  );

  const setupPin = useCallback(
    async (pin: string) => {
      const res = await api.pinSetup(pin);
      await refresh();
      return res.backup_code;
    },
    [refresh]
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    await refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ phase, status, refresh, loginWithWebauthn, loginWithPin, redeemBackupCode, registerWebauthn, setupPin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
