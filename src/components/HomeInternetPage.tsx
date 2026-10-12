import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { HomeNetworkConnection, HomeNetworkDevice, HomeNetworkPoint } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import { CONNECTION_LABEL, CONNECTION_ORDER, HomeNetworkDeviceModal, type RoomOption } from './HomeNetworkDeviceModal';
import { Modal } from './Modal';

type GroupBy = 'point' | 'room' | 'type' | 'connection' | 'none';
const GROUP_KEY = 'mikeos.home.internet.groupBy';
const GROUP_LABEL: Record<GroupBy, string> = { point: 'Point', room: 'Room', type: 'Type', connection: 'Connection', none: 'Nothing' };

function readGroupBy(): GroupBy {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    return v && v in GROUP_LABEL ? (v as GroupBy) : 'point';
  } catch {
    return 'point';
  }
}

/** Numeric IP sort key ("192.168.86.9" before "192.168.86.10"); non-IPs last. */
function ipKey(ip: string | null): string {
  const m = ip?.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? m.slice(1).map((n) => n.padStart(3, '0')).join('.') : `~${ip ?? ''}`;
}

export function connectionClass(c: HomeNetworkConnection | null) {
  return `home-net-conn home-net-conn--${c ? c.replace('.', '') : 'none'}`;
}

/** Home → Internet: every internet-connected device in the house, typed in
 * by hand from the Google Home app's Devices list. Grouped by Wi-Fi point
 * (managed list) by default; each device can also sit in a room, which the
 * room view picks up (HomeRoomDevicesButton). */
export function HomeInternetPage({ rooms }: { rooms: RoomOption[] }) {
  const [devices, setDevices] = useState<HomeNetworkDevice[] | null>(null);
  const [points, setPoints] = useState<HomeNetworkPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupByState] = useState<GroupBy>(readGroupBy);
  const [connFilter, setConnFilter] = useState<HomeNetworkConnection | 'none' | null>(null);
  const [editing, setEditing] = useState<HomeNetworkDevice | 'new' | null>(null);
  const [pointsOpen, setPointsOpen] = useState(false);
  const [sortBy, setSortBy] = useState<'name' | 'ip'>('name');

  const load = useCallback(() => {
    Promise.all([api.listNetworkDevices(), api.listNetworkPoints()])
      .then(([d, p]) => {
        setDevices(d);
        setPoints(p);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setGroupBy(g: GroupBy) {
    setGroupByState(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      // not remembered
    }
  }

  // IPs / MACs used by more than one device → ⚠ on those cells.
  const dupes = useMemo(() => {
    const count = (vals: (string | null)[]) => {
      const m = new Map<string, number>();
      for (const v of vals) if (v) m.set(v.toLowerCase(), (m.get(v.toLowerCase()) ?? 0) + 1);
      return new Set([...m].filter(([, n]) => n > 1).map(([k]) => k));
    };
    return { ip: count((devices ?? []).map((d) => d.ipAddress)), mac: count((devices ?? []).map((d) => d.macAddress)) };
  }, [devices]);

  if (error) return <div className="empty-state">Couldn't load Internet devices: {error}</div>;
  if (!devices) return <div className="empty-state">Loading…</div>;

  const q = query.trim().toLowerCase();
  const shown = devices.filter((d) => {
    if (connFilter && (d.connection ?? 'none') !== connFilter) return false;
    if (!q) return true;
    return [d.name, d.deviceType, d.manufacturer, d.model, d.pointName, d.roomName, d.macAddress, d.ipAddress, d.notes].some((v) => v?.toLowerCase().includes(q));
  });

  const counts = new Map<string, number>();
  for (const d of devices) counts.set(d.connection ?? 'none', (counts.get(d.connection ?? 'none') ?? 0) + 1);

  // Group.
  const groups: { key: string; label: string; items: HomeNetworkDevice[] }[] = [];
  const keyOf = (d: HomeNetworkDevice): [string, string] => {
    switch (groupBy) {
      case 'point':
        return d.pointId ? [d.pointId, d.pointName ?? 'Point'] : ['~', 'No Point'];
      case 'room':
        return d.roomId ? [d.roomId, `${d.roomName}${d.floorName ? ` · ${d.floorName}` : ''}`] : ['~', 'No Room'];
      case 'type':
        return d.deviceType ? [d.deviceType.toLowerCase(), d.deviceType] : ['~', 'No Type'];
      case 'connection':
        return d.connection ? [String(CONNECTION_ORDER.indexOf(d.connection)), CONNECTION_LABEL[d.connection]] : ['~', 'Connection Not Set'];
      default:
        return ['all', ''];
    }
  };
  for (const d of shown) {
    const [key, label] = keyOf(d);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, label, items: [] }));
    g.items.push(d);
  }
  if (groupBy === 'point') {
    const order = new Map(points.map((p, i) => [p.id, i]));
    groups.sort((a, b) => (order.get(a.key) ?? 1e6) - (order.get(b.key) ?? 1e6));
  } else {
    groups.sort((a, b) => (a.key === '~' ? 1 : b.key === '~' ? -1 : groupBy === 'connection' ? a.key.localeCompare(b.key) : a.label.localeCompare(b.label)));
  }
  for (const g of groups)
    g.items.sort((a, b) => (sortBy === 'ip' ? ipKey(a.ipAddress).localeCompare(ipKey(b.ipAddress)) : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  function onSaved(saved: HomeNetworkDevice) {
    setDevices((prev) => {
      const list = prev ?? [];
      return list.some((d) => d.id === saved.id) ? list.map((d) => (d.id === saved.id ? saved : d)) : [...list, saved];
    });
    setEditing(null);
    api.listNetworkPoints().then(setPoints).catch(() => {});
  }

  const filterChips: { key: HomeNetworkConnection | 'none'; label: string }[] = [
    ...CONNECTION_ORDER.filter((c) => counts.get(c)).map((c) => ({ key: c, label: CONNECTION_LABEL[c] })),
    ...(counts.get('none') ? [{ key: 'none' as const, label: 'Not Set' }] : []),
  ];

  return (
    <div className="home-net">
      <div className="home-net__toolbar">
        <input className="home-net__search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, type, MAC, IP…" aria-label="Search devices" />
        <label className="home-net__group">
          <span>Group By</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <div className="home-net__actions">
          <button className="btn btn--ghost" onClick={() => setPointsOpen(true)}>
            📶 Points{points.length ? ` (${points.length})` : ''}
          </button>
          <button className="btn" onClick={() => setEditing('new')}>
            + Add Device
          </button>
        </div>
      </div>

      {devices.length > 0 && (
        <div className="home-net__summary">
          <span className="home-net__total">
            {devices.length} Device{devices.length === 1 ? '' : 's'}
          </span>
          {filterChips.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`home-net__chip${connFilter === c.key ? ' is-active' : ''}`}
              onClick={() => setConnFilter((prev) => (prev === c.key ? null : c.key))}
            >
              <span className={connectionClass(c.key === 'none' ? null : c.key)} aria-hidden />
              {c.label} <b>{counts.get(c.key)}</b>
            </button>
          ))}
        </div>
      )}

      {devices.length === 0 ? (
        <div className="empty-state empty-state--section">
          No devices yet. Add your Wi-Fi points first (📶 Points — the router, Basement, Study Puck…), then add each device from the Google Home app's Devices list.
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state empty-state--section">Nothing matches.</div>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="home-net__section">
            {groupBy !== 'none' && (
              <h3 className="home-net__section-title">
                {g.label} <span>{g.items.length}</span>
              </h3>
            )}
            <table className="home-net__table">
              <thead>
                <tr>
                  <th>
                    <button type="button" className={`home-net__sort${sortBy === 'name' ? ' is-active' : ''}`} onClick={() => setSortBy('name')}>
                      Device{sortBy === 'name' ? ' ↓' : ''}
                    </button>
                  </th>
                  <th>Connection</th>
                  <th>Point</th>
                  <th>Room</th>
                  <th>MAC Address</th>
                  <th>
                    <button type="button" className={`home-net__sort${sortBy === 'ip' ? ' is-active' : ''}`} onClick={() => setSortBy('ip')}>
                      IP Address{sortBy === 'ip' ? ' ↓' : ''}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((d) => (
                  <tr key={d.id} onClick={() => setEditing(d)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setEditing(d)}>
                    <td>
                      <div className="home-net__name">{d.name}</div>
                      <DeviceSub d={d} />
                    </td>
                    <td>
                      <ConnectionTag c={d.connection} />
                    </td>
                    <td>{d.pointName ?? <span className="home-net__muted">—</span>}</td>
                    <td>{d.roomName ?? <span className="home-net__muted">—</span>}</td>
                    <td className="home-net-mono">
                      {d.macAddress ?? <span className="home-net__muted">—</span>}
                      {d.macAddress && dupes.mac.has(d.macAddress.toLowerCase()) && <Dupe what="MAC" />}
                    </td>
                    <td className="home-net-mono">
                      {d.ipAddress ?? <span className="home-net__muted">—</span>}
                      {d.ipReserved && d.ipAddress && (
                        <span className="home-net__reserved" title="Reserved / static">
                          Reserved
                        </span>
                      )}
                      {d.ipAddress && dupes.ip.has(d.ipAddress.toLowerCase()) && <Dupe what="IP" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="home-net__cards">
              {g.items.map((d) => (
                <button key={d.id} type="button" className="home-net__card" onClick={() => setEditing(d)}>
                  <div className="home-net__card-head">
                    <span className="home-net__name">{d.name}</span>
                    <ConnectionTag c={d.connection} />
                  </div>
                  <DeviceSub d={d} />
                  <div className="home-net__card-facts">
                    {(d.pointName || d.roomName) && <span>{[d.pointName && `📶 ${d.pointName}`, d.roomName && `🏠 ${d.roomName}`].filter(Boolean).join('  ·  ')}</span>}
                    {d.ipAddress && (
                      <span className="home-net-mono">
                        IP {d.ipAddress}
                        {d.ipReserved && <span className="home-net__reserved">Reserved</span>}
                        {dupes.ip.has(d.ipAddress.toLowerCase()) && <Dupe what="IP" />}
                      </span>
                    )}
                    {d.macAddress && (
                      <span className="home-net-mono">
                        MAC {d.macAddress}
                        {dupes.mac.has(d.macAddress.toLowerCase()) && <Dupe what="MAC" />}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {editing && (
        <HomeNetworkDeviceModal
          device={editing}
          points={points}
          rooms={rooms}
          allDevices={devices}
          onSaved={onSaved}
          onDeleted={(id) => {
            setDevices((prev) => (prev ?? []).filter((d) => d.id !== id));
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {pointsOpen && <NetworkPointsModal points={points} onChanged={load} onClose={() => setPointsOpen(false)} />}
    </div>
  );
}

function DeviceSub({ d }: { d: HomeNetworkDevice }) {
  const make = [d.manufacturer, d.model].filter(Boolean).join(' ');
  const parts = [d.deviceType, make && make !== d.deviceType ? make : null].filter(Boolean);
  if (!parts.length) return null;
  return <div className="home-net__sub">{parts.join(' · ')}</div>;
}

export function ConnectionTag({ c }: { c: HomeNetworkConnection | null }) {
  if (!c) return <span className="home-net__muted">—</span>;
  return (
    <span className="home-net__conn-tag">
      <span className={connectionClass(c)} aria-hidden />
      {CONNECTION_LABEL[c]}
    </span>
  );
}

function Dupe({ what }: { what: string }) {
  return (
    <span className="home-net__dupe" title={`Another device has the same ${what}`}>
      ⚠
    </span>
  );
}

/** Manage the Wi-Fi points list: add, rename (+ notes), delete. */
function NetworkPointsModal({ points, onChanged, onClose }: { points: HomeNetworkPoint[]; onChanged: () => void; onClose: () => void }) {
  const [editing, setEditing] = useState<HomeNetworkPoint | 'new' | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [deleting, setDeleting] = useState<HomeNetworkPoint | null>(null);

  function open(p: HomeNetworkPoint | 'new') {
    setName(p === 'new' ? '' : p.name);
    setNotes(p === 'new' ? '' : (p.notes ?? ''));
    setEditing(p);
  }

  async function save() {
    if (!name.trim()) return;
    if (editing === 'new') await api.createNetworkPoint({ name: name.trim(), notes: notes.trim() || null });
    else if (editing) await api.updateNetworkPoint(editing.id, { name: name.trim(), notes: notes.trim() || null });
    setEditing(null);
    onChanged();
  }

  if (editing) {
    return (
      <Modal title={editing === 'new' ? 'Add Point' : `Edit "${editing.name}"`} onClose={() => setEditing(null)}>
        <label className="wallet-editor__field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Router, Basement, Study Puck" />
        </label>
        <label className="wallet-editor__field" style={{ marginTop: 10 }}>
          <span>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Nest Wifi Pro, on the bookshelf" />
        </label>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button className="btn" onClick={save} disabled={!name.trim()}>
            {editing === 'new' ? 'Add' : 'Save'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Wi-Fi Points" onClose={onClose}>
      {points.length === 0 ? (
        <div className="home-net__muted" style={{ fontSize: 13 }}>
          No points yet — add your router and each mesh point as Google Home names them.
        </div>
      ) : (
        <div className="home-net-points">
          {points.map((p) => (
            <div key={p.id} className="home-net-points__row">
              <button type="button" className="home-net-points__main" onClick={() => open(p)}>
                <span className="home-net__name">{p.name}</span>
                {p.notes && <span className="home-net__sub">{p.notes}</span>}
              </button>
              <span className="home-net-points__count">
                {p.deviceCount} device{p.deviceCount === 1 ? '' : 's'}
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Done
        </button>
        <button className="btn" onClick={() => open('new')}>
          + Add Point
        </button>
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete this point?"
          body={`"${deleting.name}" will be deleted. Its ${deleting.deviceCount} device${deleting.deviceCount === 1 ? '' : 's'} stay — they just won't have a point.`}
          onConfirm={async () => {
            await api.deleteNetworkPoint(deleting.id);
            setDeleting(null);
            onChanged();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Modal>
  );
}
