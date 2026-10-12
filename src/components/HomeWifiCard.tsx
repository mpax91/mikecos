import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { HomeWifiNetwork, HomeWifiSecurity } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import { Modal } from './Modal';

const SECURITY_LABEL: Record<HomeWifiSecurity, string> = { WPA: 'WPA / WPA2 / WPA3', WEP: 'WEP', nopass: 'None (Open)' };

/** The standard Wi-Fi join string phone cameras understand:
 * WIFI:T:WPA;S:<ssid>;P:<password>;H:true;; — with \ ; , : " escaped. */
export function wifiQrString(ssid: string, password: string | null, security: HomeWifiSecurity, hidden: boolean): string {
  const esc = (v: string) => v.replace(/([\\;,:"])/g, '\\$1');
  const parts = [`T:${security}`, `S:${esc(ssid)}`];
  if (security !== 'nopass' && password) parts.push(`P:${esc(password)}`);
  if (hidden) parts.push('H:true');
  return `WIFI:${parts.join(';')};;`;
}

function speed(v: number | null): string | null {
  if (v == null) return null;
  return v >= 1000 ? `${+(v / 1000).toFixed(2)} Gbps` : `${+v.toFixed(1)} Mbps`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Home → Internet: the house's Wi-Fi networks (main, guest…) with the
 * password (encrypted at rest, revealed on tap) and a join-by-QR sheet a
 * guest can scan straight off Mike's phone. */
export function HomeWifiCard() {
  const [networks, setNetworks] = useState<HomeWifiNetwork[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<HomeWifiNetwork | 'new' | null>(null);
  const [qrFor, setQrFor] = useState<HomeWifiNetwork | null>(null);

  const load = useCallback(() => {
    api
      .listWifiNetworks()
      .then(setNetworks)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="empty-state">Couldn't load Wi-Fi: {error}</div>;
  if (!networks) return null;

  return (
    <section className="home-wifi">
      <div className="home-wifi__head">
        <h3 className="home-net__section-title" style={{ margin: 0 }}>
          Wi-Fi
        </h3>
        <button className="btn btn--ghost btn--sm" onClick={() => setEditing('new')}>
          + Add Network
        </button>
      </div>

      {networks.length === 0 ? (
        <div className="home-wifi__empty">
          Save your Wi-Fi name and password here to share it with a QR code.{' '}
          <button type="button" className="btn btn--sm" onClick={() => setEditing('new')}>
            Add Wi-Fi
          </button>
        </div>
      ) : (
        <div className="home-wifi__grid">
          {networks.map((n) => (
            <WifiTile key={n.id} net={n} onEdit={() => setEditing(n)} onQr={() => setQrFor(n)} />
          ))}
        </div>
      )}

      {editing && (
        <WifiEditor
          net={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {qrFor && <WifiQrModal net={qrFor} onClose={() => setQrFor(null)} />}
    </section>
  );
}

function WifiTile({ net, onEdit, onQr }: { net: HomeWifiNetwork; onEdit: () => void; onQr: () => void }) {
  const [password, setPassword] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal(): Promise<string | null> {
    if (password != null) return password;
    const { password: p } = await api.getWifiPassword(net.id);
    setPassword(p);
    return p;
  }

  async function copyPassword() {
    const p = await reveal();
    if (p && (await copy(p))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  const speeds = [net.downloadMbps != null && `↓ ${speed(net.downloadMbps)}`, net.uploadMbps != null && `↑ ${speed(net.uploadMbps)}`].filter(Boolean).join('  ');

  return (
    <div className="home-wifi__tile">
      <div className="home-wifi__tile-top">
        <div style={{ minWidth: 0 }}>
          {net.label && <div className="home-wifi__label">{net.label}</div>}
          <div className="home-wifi__ssid">{net.ssid}</div>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onEdit}>
          Edit
        </button>
      </div>

      <dl className="home-wifi__facts">
        <dt>Password</dt>
        <dd>
          {net.security === 'nopass' ? (
            <span className="home-net__muted">Open network</span>
          ) : !net.hasPassword ? (
            <span className="home-net__muted">Not saved</span>
          ) : (
            <>
              <span className="home-net-mono home-wifi__pw">{shown && password != null ? password : '••••••••'}</span>
              <button
                type="button"
                className="home-wifi__link"
                onClick={async () => {
                  if (!shown) await reveal();
                  setShown((s) => !s);
                }}
              >
                {shown ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="home-wifi__link" onClick={copyPassword}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </>
          )}
        </dd>
        {net.plan && (
          <>
            <dt>Plan</dt>
            <dd>{net.plan}</dd>
          </>
        )}
        {speeds && (
          <>
            <dt>Speed</dt>
            <dd>{speeds}</dd>
          </>
        )}
        {net.notes && (
          <>
            <dt>Notes</dt>
            <dd>{net.notes}</dd>
          </>
        )}
      </dl>

      <button type="button" className="btn home-wifi__qr-btn" onClick={onQr}>
        ▦ Show QR to Join
      </button>
    </div>
  );
}

function WifiQrModal({ net, onClose }: { net: HomeWifiNetwork; onClose: () => void }) {
  const [password, setPassword] = useState<string | null | undefined>(net.hasPassword ? undefined : null);

  useEffect(() => {
    if (net.hasPassword) {
      api
        .getWifiPassword(net.id)
        .then((r) => setPassword(r.password))
        .catch(() => setPassword(null));
    }
  }, [net]);

  return (
    <Modal title={`Join ${net.ssid}`} onClose={onClose} className="home-wifi-qr">
      {password === undefined ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="home-wifi-qr__body">
          <div className="home-wifi-qr__code">
            <QRCodeSVG value={wifiQrString(net.ssid, password, net.security, net.hidden)} size={248} level="M" marginSize={2} />
          </div>
          <div className="home-wifi-qr__hint">Open the camera on your phone and point it at the code, then tap the Wi-Fi prompt.</div>
          <dl className="home-wifi-qr__text">
            <dt>Network</dt>
            <dd>{net.ssid}</dd>
            {net.security !== 'nopass' && password && (
              <>
                <dt>Password</dt>
                <dd className="home-net-mono">{password}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </Modal>
  );
}

function WifiEditor({ net, onClose, onSaved }: { net: HomeWifiNetwork | 'new'; onClose: () => void; onSaved: () => void }) {
  const n = net === 'new' ? null : net;
  const [ssid, setSsid] = useState(n?.ssid ?? '');
  const [label, setLabel] = useState(n?.label ?? '');
  const [password, setPassword] = useState('');
  const [pwLoaded, setPwLoaded] = useState(!n?.hasPassword);
  const [showPw, setShowPw] = useState(false);
  const [security, setSecurity] = useState<HomeWifiSecurity>(n?.security ?? 'WPA');
  const [hidden, setHidden] = useState(n?.hidden ?? false);
  const [plan, setPlan] = useState(n?.plan ?? '');
  const [down, setDown] = useState(n?.downloadMbps != null ? String(n.downloadMbps) : '');
  const [up, setUp] = useState(n?.uploadMbps != null ? String(n.uploadMbps) : '');
  const [notes, setNotes] = useState(n?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (n?.hasPassword) {
      api
        .getWifiPassword(n.id)
        .then((r) => {
          setPassword(r.password ?? '');
          setPwLoaded(true);
        })
        .catch(() => setPwLoaded(true));
    }
  }, [n]);

  async function save() {
    if (!ssid.trim() || saving || !pwLoaded) return;
    setSaving(true);
    setErr(null);
    const num = (v: string) => (v.trim() ? Number(v) : null);
    const payload = {
      ssid: ssid.trim(),
      label: label.trim() || null,
      password: security === 'nopass' ? null : password || null,
      security,
      hidden,
      plan: plan.trim() || null,
      downloadMbps: num(down),
      uploadMbps: num(up),
      notes: notes.trim() || null,
    };
    try {
      if (n) await api.updateWifiNetwork(n.id, payload);
      else await api.createWifiNetwork(payload);
      onSaved();
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={n ? `Edit "${n.ssid}"` : 'Add Wi-Fi Network'} onClose={onClose} className="home-net-modal">
      <div className="home-net-modal__form">
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Network Name</span>
            <input autoFocus value={ssid} onChange={(e) => setSsid(e.target.value)} placeholder="SSID" autoCapitalize="off" spellCheck={false} />
          </label>
          <label className="wallet-editor__field">
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Main, Guest" />
          </label>
        </div>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Security</span>
            <select value={security} onChange={(e) => setSecurity(e.target.value as HomeWifiSecurity)}>
              {(Object.keys(SECURITY_LABEL) as HomeWifiSecurity[]).map((s) => (
                <option key={s} value={s}>
                  {SECURITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          {security !== 'nopass' && (
            <label className="wallet-editor__field">
              <span>Password</span>
              <div className="home-wifi__pw-input">
                <input
                  type={showPw ? 'text' : 'password'}
                  className="home-net-mono"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={pwLoaded ? '' : 'Loading…'}
                  disabled={!pwLoaded}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button type="button" className="home-wifi__link" onClick={() => setShowPw((s) => !s)}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
          )}
        </div>
        <label className="wallet-editor__checkbox-field">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Hidden network (doesn't broadcast its name)
        </label>
        <label className="wallet-editor__field">
          <span>Plan</span>
          <input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="e.g. Verizon Fios 1 Gig" />
        </label>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Download (Mbps)</span>
            <input inputMode="decimal" value={down} onChange={(e) => setDown(e.target.value)} placeholder="e.g. 940" />
          </label>
          <label className="wallet-editor__field">
            <span>Upload (Mbps)</span>
            <input inputMode="decimal" value={up} onChange={(e) => setUp(e.target.value)} placeholder="e.g. 880" />
          </label>
        </div>
        <label className="wallet-editor__field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {err && <div className="home-net-modal__error">{err}</div>}
      </div>
      <div className="modal__actions">
        {n && (
          <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setDeleting(true)}>
            Delete
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!ssid.trim() || saving || !pwLoaded}>
          {n ? 'Save' : 'Add'}
        </button>
      </div>
      {deleting && n && (
        <ConfirmModal
          title="Delete this network?"
          body={`"${n.ssid}" and its saved password will be removed from MikeOS.`}
          onConfirm={async () => {
            await api.deleteWifiNetwork(n.id);
            onSaved();
          }}
          onCancel={() => setDeleting(false)}
        />
      )}
    </Modal>
  );
}
