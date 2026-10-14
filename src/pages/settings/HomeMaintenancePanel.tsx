import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { HomeMaintData, HomeMaintItem } from '../../api/types';
import { HomeMaintItemModal } from '../../components/HomeMaintModals';

const every = (m: number) => (m % 12 === 0 ? (m === 12 ? 'every year' : `every ${m / 12} years`) : `every ${m} months`);
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Common recurring jobs, one tap to start from (Mike edits before saving). */
const PRESETS = [
  { name: 'Septic Pump-Out', system: 'Septic', matchWords: 'pump', intervalMonths: 48, leadDays: 60 },
  { name: 'Chimney Sweep', system: 'Chimney', matchWords: 'sweep, clean, inspect', intervalMonths: 12, leadDays: 30 },
  { name: 'HVAC Service', system: 'HVAC', matchWords: 'tune, service, maintenance, clean', intervalMonths: 12, leadDays: 30 },
  { name: 'Gutter Cleaning', system: 'Exterior', matchWords: 'gutter', intervalMonths: 6, leadDays: 14 },
  { name: 'Water Heater Flush', system: 'Plumbing', matchWords: 'flush, water heater', intervalMonths: 12, leadDays: 14 },
  { name: 'Dryer Vent Cleaning', system: 'Appliances', matchWords: 'dryer', intervalMonths: 12, leadDays: 14 },
  { name: 'Generator Service', system: 'Electrical', matchWords: 'generator', intervalMonths: 12, leadDays: 30 },
];

/** Settings → Home Maintenance: the Drive folder and the recurring items
 * (how often each job is due and how early it lands on Today). The
 * dashboard itself is Home → 🔧 Maintenance. */
export function HomeMaintenancePanel() {
  const [data, setData] = useState<HomeMaintData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<HomeMaintItem | 'new' | null>(null);
  const [preset, setPreset] = useState<(typeof PRESETS)[number] | undefined>();
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getHomeMaint()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  async function scan() {
    setScanning(true);
    setScanNote(null);
    try {
      const r = await api.scanHomeMaint();
      setScanNote(r.error ?? `${r.listed} file${r.listed === 1 ? '' : 's'} in the folder · ${r.added} new · ${r.updated} changed${r.missing ? ` · ${r.missing} gone` : ''}`);
      load();
    } catch (e) {
      setScanNote(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function toggle(i: HomeMaintItem) {
    await api.updateHomeMaintItem(i.id, { active: !i.active });
    load();
  }

  const taken = new Set((data?.items ?? []).map((i) => i.name.toLowerCase()));
  const presets = PRESETS.filter((p) => !taken.has(p.name.toLowerCase()));

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Home Maintenance</h2>
        <Link to="/home?section=maintenance" className="btn btn--ghost btn--sm">
          Open Dashboard →
        </Link>
      </div>
      <p className="settings-page__section-hint">
        Receipts go in the Google Drive folder <strong>Home Maintenance</strong> (top level), named <code>YYYY.MM.DD - System - Vendor - Service - $Amount.pdf</code> — e.g.{' '}
        <code>2026.10.12 - Septic - ABC Septic - Pump-Out - $525.pdf</code>. Only the name is read. Systems: {(data?.systems ?? []).join(', ')}.
      </p>

      {error && <div className="wallet-editor__error">{error}</div>}

      <div className="manage-list" style={{ marginBottom: 24 }}>
        <div className="manage-row">
          <div className="manage-row__body">
            <div className="manage-row__title">
              {data?.folder.name ? (
                data.folder.url ? (
                  <a href={data.folder.url} target="_blank" rel="noreferrer">
                    📁 {data.folder.name} ↗
                  </a>
                ) : (
                  <>📁 {data.folder.name}</>
                )
              ) : (
                '📁 Folder not found yet'
              )}
            </div>
            <div className="wallet-editor__hint">
              {data?.folder.lastScanAt
                ? `Checked ${new Date(data.folder.lastScanAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · checked nightly`
                : 'Checked nightly — or Scan Now once the folder exists'}
              {data ? ` · ${data.records.length} record${data.records.length === 1 ? '' : 's'}` : ''}
            </div>
            {(scanNote || data?.folder.lastError) && <div className="wallet-editor__hint">{scanNote ?? data?.folder.lastError}</div>}
          </div>
          <div className="manage-row__actions">
            <button type="button" className="btn btn--ghost" style={{ whiteSpace: 'nowrap' }} onClick={scan} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Scan Now'}
            </button>
          </div>
        </div>
      </div>

      <div className="toolbar-row">
        <h3 className="settings-page__section-title" style={{ fontSize: 16 }}>
          Recurring Items
        </h3>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setPreset(undefined);
            setEditing('new');
          }}
        >
          + Add Item
        </button>
      </div>
      <p className="settings-page__section-hint">
        The newest matching receipt sets the next due date. A “Schedule …” task lands on Today the set number of days before and checks itself off when the next receipt shows up.
      </p>

      {!data ? (
        <div className="empty-state">Loading…</div>
      ) : data.items.length === 0 ? (
        <div className="empty-state">No recurring items yet.</div>
      ) : (
        <div className="manage-list">
          {data.items.map((i) => (
            <div className={`manage-row${i.active ? '' : ' is-muted'}`} key={i.id}>
              <div className="manage-row__body">
                <div className="manage-row__title">
                  {i.name} <span className="hm-muted">· {i.system}</span>
                </div>
                <div className="wallet-editor__hint">
                  {[
                    i.intervalMonths ? `${every(i.intervalMonths)}, remind ${i.leadDays} day${i.leadDays === 1 ? '' : 's'} before` : 'history only',
                    i.nextDue ? `next due ${fmtDate(i.nextDue)}${i.overrideActive ? ' (set by hand)' : ''}` : i.status === 'unknown' ? 'no receipt yet — set Next Due' : null,
                    i.matchWords ? `counts “${i.matchWords}”` : null,
                    i.active ? null : 'paused',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="manage-row__actions">
                <button type="button" className="btn btn--ghost" onClick={() => toggle(i)}>
                  {i.active ? 'Pause' : 'Resume'}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setEditing(i)}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {presets.length > 0 && (
        <div className="hm-presets">
          <span className="wallet-editor__hint">Quick add:</span>
          {presets.map((p) => (
            <button
              key={p.name}
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setPreset(p);
                setEditing('new');
              }}
            >
              + {p.name}
            </button>
          ))}
        </div>
      )}

      {editing && data && (
        <HomeMaintItemModal
          item={editing === 'new' ? null : editing}
          preset={editing === 'new' ? preset : undefined}
          systems={data.systems}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}
