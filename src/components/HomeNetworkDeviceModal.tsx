import { useState } from 'react';
import { api } from '../api/client';
import type { HomeNetworkConnection, HomeNetworkDevice, HomeNetworkPoint } from '../api/types';
import { ConfirmModal } from './ConfirmModal';
import { Modal } from './Modal';

export const CONNECTION_LABEL: Record<HomeNetworkConnection, string> = {
  wired: 'Wired',
  '2.4ghz': '2.4 GHz',
  '5ghz': '5 GHz',
  '6ghz': '6 GHz',
};

export const CONNECTION_ORDER: HomeNetworkConnection[] = ['wired', '2.4ghz', '5ghz', '6ghz'];

/** A room the device can be tied to, for the Room dropdown (grouped by floor). */
export interface RoomOption {
  id: string;
  name: string;
  floorId: string;
  floorName: string;
}

/** Add / edit one internet-connected device (Home → Internet). Type and
 * Manufacturer offer what's already been typed on other devices. */
export function HomeNetworkDeviceModal({
  device,
  defaults,
  points,
  rooms,
  allDevices,
  onSaved,
  onDeleted,
  onClose,
}: {
  device: HomeNetworkDevice | 'new';
  /** Prefill for a new device (e.g. the room it was added from). */
  defaults?: { roomId?: string | null; pointId?: string | null };
  points: HomeNetworkPoint[];
  rooms: RoomOption[];
  /** Every device — feeds the Type / Manufacturer suggestions. */
  allDevices: HomeNetworkDevice[];
  onSaved: (d: HomeNetworkDevice) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const isNew = device === 'new';
  const d = isNew ? null : device;
  const [name, setName] = useState(d?.name ?? '');
  const [deviceType, setDeviceType] = useState(d?.deviceType ?? '');
  const [manufacturer, setManufacturer] = useState(d?.manufacturer ?? '');
  const [model, setModel] = useState(d?.model ?? '');
  const [connection, setConnection] = useState<HomeNetworkConnection | ''>(d?.connection ?? '');
  const [pointId, setPointId] = useState(d?.pointId ?? defaults?.pointId ?? '');
  const [roomId, setRoomId] = useState(d?.roomId ?? defaults?.roomId ?? '');
  const [mac, setMac] = useState(d?.macAddress ?? '');
  const [ip, setIp] = useState(d?.ipAddress ?? '');
  const [ipReserved, setIpReserved] = useState(d?.ipReserved ?? false);
  const [notes, setNotes] = useState(d?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const uniq = (vals: (string | null)[]) => [...new Set(vals.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
  const typeOptions = uniq(allDevices.map((x) => x.deviceType));
  const makerOptions = uniq(allDevices.map((x) => x.manufacturer));

  const floors: { id: string; name: string; rooms: RoomOption[] }[] = [];
  for (const r of rooms) {
    let f = floors.find((x) => x.id === r.floorId);
    if (!f) floors.push((f = { id: r.floorId, name: r.floorName, rooms: [] }));
    f.rooms.push(r);
  }

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim(),
      deviceType: deviceType.trim() || null,
      manufacturer: manufacturer.trim() || null,
      model: model.trim() || null,
      connection: connection || null,
      pointId: pointId || null,
      roomId: roomId || null,
      macAddress: mac.trim() || null,
      ipAddress: ip.trim() || null,
      ipReserved,
      notes: notes.trim() || null,
    };
    try {
      const saved = d ? await api.updateNetworkDevice(d.id, payload) : await api.createNetworkDevice(payload);
      onSaved(saved);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!d) return;
    await api.deleteNetworkDevice(d.id);
    onDeleted(d.id);
  }

  return (
    <Modal title={isNew ? 'Add Device' : `Edit "${d!.name}"`} onClose={onClose} className="home-net-modal">
      <div className="home-net-modal__form">
        <label className="wallet-editor__field">
          <span>Device Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kitchen Speaker" />
        </label>
        <label className="wallet-editor__field">
          <span>Type</span>
          <input list="home-net-types" value={deviceType} onChange={(e) => setDeviceType(e.target.value)} placeholder="e.g. Google Home Mini" />
          <datalist id="home-net-types">
            {typeOptions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Manufacturer</span>
            <input list="home-net-makers" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="e.g. Google" />
            <datalist id="home-net-makers">
              {makerOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="wallet-editor__field">
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. H0A" />
          </label>
        </div>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>Connection</span>
            <select value={connection} onChange={(e) => setConnection(e.target.value as HomeNetworkConnection | '')}>
              <option value="">—</option>
              <option value="wired">Wired</option>
              <option value="2.4ghz">Wireless · 2.4 GHz</option>
              <option value="5ghz">Wireless · 5 GHz</option>
              <option value="6ghz">Wireless · 6 GHz</option>
            </select>
          </label>
          <label className="wallet-editor__field">
            <span>Point</span>
            <select value={pointId} onChange={(e) => setPointId(e.target.value)}>
              <option value="">{points.length ? '—' : 'No Points Yet'}</option>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="bar-item-modal__row">
          <label className="wallet-editor__field">
            <span>MAC Address</span>
            <input className="home-net-mono" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" autoCapitalize="characters" spellCheck={false} />
          </label>
          <label className="wallet-editor__field">
            <span>IP Address</span>
            <input className="home-net-mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.86.20" inputMode="decimal" spellCheck={false} />
          </label>
        </div>
        <label className="wallet-editor__checkbox-field">
          <input type="checkbox" checked={ipReserved} onChange={(e) => setIpReserved(e.target.checked)} />
          Reserved / Static IP
        </label>
        <label className="wallet-editor__field">
          <span>Room</span>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">—</option>
            {floors.map((f) => (
              <optgroup key={f.id} label={f.name}>
                {f.rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="wallet-editor__field">
          <span>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <div className="home-net-modal__error">{error}</div>}
      </div>
      <div className="modal__actions">
        {!isNew && (
          <button className="btn btn--ghost" style={{ color: 'var(--color-danger, #c0392b)', marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={!name.trim() || saving}>
          {isNew ? 'Add' : 'Save'}
        </button>
      </div>
      {confirmDelete && d && (
        <ConfirmModal title="Delete this device?" body={`"${d.name}" will be removed from Home → Internet.`} onConfirm={doDelete} onCancel={() => setConfirmDelete(false)} />
      )}
    </Modal>
  );
}
