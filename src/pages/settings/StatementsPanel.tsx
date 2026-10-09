import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { AccountOwner, StatementDriveAccount, StatementFolder } from '../../api/types';

const STATUS_LABEL = { live: 'Live', needs_template: 'Needs Template', ignored: 'Ignored' } as const;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Settings → Statements: every top-level folder in each connected Google
 * Drive, with its status (Live / Needs Template / Ignored). Live folders
 * get their account settings, coverage and a Scan Now button. */
export function StatementsPanel() {
  const [accounts, setAccounts] = useState<StatementDriveAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<Record<string, string>>({});
  const [showIgnored, setShowIgnored] = useState(false);

  const load = useCallback(() => {
    api
      .listStatementDriveFolders()
      .then(setAccounts)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function register(acct: StatementDriveAccount, f: StatementDriveAccount['folders'][number], status: 'live' | 'ignored' | 'needs_template') {
    setBusy(f.folderId);
    try {
      if (f.registered) await api.updateStatementFolder(f.registered.id, { status });
      else
        await api.registerStatementFolder({
          accountId: acct.accountId,
          folderId: f.folderId,
          folderName: f.folderName,
          folderUrl: f.folderUrl,
          status,
          templateId: status === 'live' ? f.suggestedTemplateId : null,
        });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function scan(folder: StatementFolder) {
    setBusy(folder.id);
    setScanMsg((m) => ({ ...m, [folder.id]: 'Reading statements…' }));
    try {
      // Each pass reads up to 12 PDFs; keep going (a folder with years of
      // bills takes several passes) until it's caught up.
      const r = await api.scanStatementFolder(folder.id);
      for (let pass = 1; pass < 15 && r.remaining > 0; pass++) {
        setScanMsg((m) => ({ ...m, [folder.id]: `Reading statements… ${r.read} done, ${r.remaining} to go` }));
        const next = await api.scanStatementFolder(folder.id);
        Object.assign(r, {
          listed: next.listed,
          read: r.read + next.read,
          parsed: r.parsed + next.parsed,
          unreadable: r.unreadable + next.unreadable,
          duplicates: r.duplicates + next.duplicates,
          remaining: next.remaining,
          errors: [...r.errors, ...next.errors],
        });
      }
      const parts = [`${r.listed} PDFs in folder`, `${r.parsed} read`];
      if (r.unreadable) parts.push(`${r.unreadable} unreadable`);
      if (r.duplicates) parts.push(`${r.duplicates} duplicate`);
      if (r.remaining) parts.push(`${r.remaining} still to read — runs again tonight`);
      if (r.errors.length) parts.push(`errors: ${r.errors.join('; ')}`);
      if (!r.read) parts.splice(1, 1, 'nothing new');
      setScanMsg((m) => ({ ...m, [folder.id]: parts.join(' · ') }));
      load();
    } catch (e) {
      setScanMsg((m) => ({ ...m, [folder.id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  const live = (accounts ?? []).flatMap((a) => a.folders.filter((f) => f.registered?.status === 'live').map((f) => f.registered!));

  return (
    <div className="settings-page__section statements-settings">
      <h2 className="settings-page__section-title">Statements</h2>
      <p className="settings-page__section-hint">
        Statement PDFs in your Google Drive folders are read every night (no AI — one template per folder, checked by arithmetic) and feed Finance,
        Vault and reminders. A folder goes Live once it has a template.
      </p>
      {error && <div className="statements-settings__error">⚠ {error}</div>}
      {!accounts && !error && <div className="empty-state empty-state--section">Loading Drive folders…</div>}
      {accounts && accounts.length === 0 && (
        <div className="empty-state empty-state--section">
          No Google Drive connected — connect one in <Link to="/settings?cat=cloud">Settings → Cloud Storage</Link>.
        </div>
      )}

      {live.length > 0 && (
        <section className="statements-settings__section">
          <h3 className="statements-settings__heading">Live Accounts</h3>
          {live.map((f) => (
            <LiveFolderCard key={f.id} folder={f} busy={busy === f.id} scanMsg={scanMsg[f.id]} onScan={() => scan(f)} onChanged={load} />
          ))}
        </section>
      )}

      {accounts?.map((acct) => {
        const folders = acct.folders.filter((f) => showIgnored || !(f.registered ? f.registered.status === 'ignored' : f.defaultIgnored));
        const hidden = acct.folders.length - folders.length;
        return (
          <section key={acct.accountId} className="statements-settings__section">
            <h3 className="statements-settings__heading">
              Google Drive · {acct.accountLabel}
              {acct.accountEmail && <span className="statements-settings__email">{acct.accountEmail}</span>}
            </h3>
            {acct.error && <div className="statements-settings__error">⚠ {acct.error}</div>}
            <div className="statements-settings__folders">
              {folders.map((f) => {
                const status = f.registered?.status ?? (f.defaultIgnored ? 'ignored' : 'needs_template');
                return (
                  <div key={f.folderId} className="statements-settings__folder">
                    <span className="statements-settings__folder-name">📁 {f.folderName}</span>
                    <span className={`statements-pill statements-pill--${status}`}>{STATUS_LABEL[status]}</span>
                    <span className="statements-settings__folder-actions">
                      {status !== 'live' && f.suggestedTemplateId && (
                        <button type="button" className="btn btn--sm" disabled={busy === f.folderId} onClick={() => register(acct, f, 'live')}>
                          Go Live
                        </button>
                      )}
                      {status === 'ignored' ? (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={busy === f.folderId} onClick={() => register(acct, f, 'needs_template')}>
                          Unignore
                        </button>
                      ) : status === 'needs_template' ? (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={busy === f.folderId} onClick={() => register(acct, f, 'ignored')}>
                          Ignore
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
            {hidden > 0 && !showIgnored && (
              <button type="button" className="btn btn--ghost btn--sm statements-settings__show-ignored" onClick={() => setShowIgnored(true)}>
                Show {hidden} Ignored
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LiveFolderCard({ folder, busy, scanMsg, onScan, onChanged }: { folder: StatementFolder; busy: boolean; scanMsg?: string; onScan: () => void; onChanged: () => void }) {
  const s = folder.settings;
  const year = new Date().getFullYear();
  const [limit, setLimit] = useState(String(s?.nyLimit ?? ''));
  const [ret, setRet] = useState(String(s?.projectionReturnPct ?? ''));
  const [redeemAt, setRedeemAt] = useState(String(s?.redeemAt ?? ''));
  const [saving, setSaving] = useState(false);

  async function save(patch: { owner?: AccountOwner; settings?: Record<string, unknown> }) {
    setSaving(true);
    try {
      await api.updateStatementFolder(folder.id, patch);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="statements-settings__live">
      <div className="statements-settings__live-head">
        <div>
          <div className="statements-settings__live-name">{folder.nickname}</div>
          <div className="statements-settings__live-meta">
            Folder “{folder.folderName}” · {folder.templateName} · {folder.coverage.parsed} of {folder.coverage.total} PDFs read · Last statement{' '}
            {fmtDate(folder.lastPeriodEnd)} · Last scan {fmtWhen(folder.lastScanAt)}
          </div>
        </div>
        <div className="statements-settings__live-actions">
          {(folder.templateId === 'ny529' || folder.templateId === 'adt' || folder.templateId === 'ally' || folder.templateId === 'amazon' || folder.templateId === 'amexBank' || folder.templateId === 'amexCard') && (
            <Link to={`/finance/${folder.id}`} className="btn btn--ghost btn--sm">
              Dashboard
            </Link>
          )}
          <button type="button" className="btn btn--sm" disabled={busy} onClick={onScan}>
            {busy ? 'Scanning…' : 'Scan Now'}
          </button>
        </div>
      </div>
      {folder.lastError && <div className="statements-settings__error">⚠ {folder.lastError}</div>}
      {scanMsg && <div className="statements-settings__scan-msg">{scanMsg}</div>}

      <div className="statements-settings__fields">
        <label className="statements-settings__field">
          <span>Owner</span>
          <select value={folder.owner} disabled={saving} onChange={(e) => save({ owner: e.target.value as AccountOwner })}>
            <option value="household">Household</option>
            <option value="chase">Chase</option>
          </select>
        </label>
        {s?.redeemAt !== undefined && (
          <label className="statements-settings__field" title="A “Redeem …” task appears once the card’s available rewards reach this amount and checks itself off when a statement shows them redeemed. 0 turns it off.">
            <span>Redeem Reminder At ($)</span>
            <input
              type="number"
              min={0}
              step={5}
              value={redeemAt}
              onChange={(e) => setRedeemAt(e.target.value)}
              onBlur={() => redeemAt !== '' && Number(redeemAt) >= 0 && Number(redeemAt) !== s.redeemAt && save({ settings: { redeemAt: Number(redeemAt) } })}
            />
          </label>
        )}
        {folder.templateId === 'ny529' && s && (
          <>
            <label className="statements-settings__field">
              <span>NY Deduction Limit ($)</span>
              <input
                type="number"
                min={0}
                step={100}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                onBlur={() => Number(limit) > 0 && Number(limit) !== s.nyLimit && save({ settings: { nyLimit: Number(limit) } })}
              />
            </label>
            <label className="statements-settings__field statements-settings__field--check">
              <input
                type="checkbox"
                checked={(s.limitConfirmedYear ?? 0) >= year}
                disabled={saving}
                onChange={(e) => save({ settings: { limitConfirmedYear: e.target.checked ? year : year - 1 } })}
              />
              <span>Limit Confirmed for {year}</span>
            </label>
            <label className="statements-settings__field">
              <span>Projection Return</span>
              <select
                value={s.projectionMode ?? 'auto'}
                disabled={saving}
                onChange={(e) => save({ settings: { projectionMode: e.target.value } })}
                title="Auto uses the fallback rate until there are 3 years of statements, then switches to your actual return on its own"
              >
                <option value="auto">Auto (Actual After 3 Yrs)</option>
                <option value="fixed">Fixed Rate</option>
              </select>
            </label>
            <label className="statements-settings__field">
              <span>{(s.projectionMode ?? 'auto') === 'auto' ? 'Until Then (%/yr)' : 'Fixed Rate (%/yr)'}</span>
              <input
                type="number"
                min={0}
                max={15}
                step={0.5}
                value={ret}
                onChange={(e) => setRet(e.target.value)}
                onBlur={() => ret !== '' && Number(ret) !== s.projectionReturnPct && save({ settings: { projectionReturnPct: Number(ret) } })}
              />
            </label>
          </>
        )}
      </div>
      {s?.redeemAt !== undefined && (
        <p className="statements-settings__hint">
          {s.redeemAt > 0 ? `A Redeem task appears once this card’s rewards reach $${s.redeemAt} and checks itself off when a statement shows them redeemed.` : 'Redeem reminder is off.'} Set 0 to turn it off.
        </p>
      )}
      {folder.templateId === 'ny529' && (
        <p className="statements-settings__hint">NY allows $10,000/yr for joint filers ($5,000 single), NY plan only, contributions by Dec 31. Check it each January.</p>
      )}
    </div>
  );
}
