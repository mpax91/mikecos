import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { HomeNetworkDevice, HomeNetworkPoint } from '../api/types';
import { ConnectionTag } from './HomeInternetPage';
import { HomeNetworkDeviceModal, type RoomOption } from './HomeNetworkDeviceModal';
import { Modal } from './Modal';

/** Room view → "📶 Devices (N)": the internet-connected devices tied to this
 * room (Home → Internet), with Add Device prefilled to the room. */
export function HomeRoomDevicesButton({ roomId, roomName, rooms }: { roomId: string; roomName: string; rooms: RoomOption[] }) {
  const [devices, setDevices] = useState<HomeNetworkDevice[] | null>(null);
  const [allDevices, setAllDevices] = useState<HomeNetworkDevice[]>([]);
  const [points, setPoints] = useState<HomeNetworkPoint[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<HomeNetworkDevice | 'new' | null>(null);

  const load = useCallback(() => {
    api
      .listNetworkDevices(roomId)
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [roomId]);

  useEffect(() => {
    load();
  }, [load]);

  function openList() {
    setOpen(true);
    // Points + every device (for the editor's dropdown / suggestions) only when needed.
    Promise.all([api.listNetworkPoints(), api.listNetworkDevices()])
      .then(([p, all]) => {
        setPoints(p);
        setAllDevices(all);
      })
      .catch(() => {});
  }

  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={openList} title="Internet-connected devices in this room">
        📶 Devices{devices?.length ? ` (${devices.length})` : ''}
      </button>

      {open && !editing && (
        <Modal title={`Devices · ${roomName}`} onClose={() => setOpen(false)}>
          {!devices ? (
            <div className="empty-state">Loading…</div>
          ) : devices.length === 0 ? (
            <div className="home-net__muted" style={{ fontSize: 13 }}>
              No internet devices in this room yet.
            </div>
          ) : (
            <div className="home-net-points">
              {devices.map((d) => (
                <div key={d.id} className="home-net-points__row">
                  <button type="button" className="home-net-points__main" onClick={() => setEditing(d)}>
                    <span className="home-net__name">{d.name}</span>
                    <span className="home-net__sub">{[d.deviceType, d.pointName && `📶 ${d.pointName}`, d.ipAddress].filter(Boolean).join(' · ')}</span>
                  </button>
                  <ConnectionTag c={d.connection} />
                </div>
              ))}
            </div>
          )}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setOpen(false)}>
              Done
            </button>
            <button className="btn" onClick={() => setEditing('new')}>
              + Add Device
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <HomeNetworkDeviceModal
          device={editing}
          defaults={{ roomId }}
          points={points}
          rooms={rooms}
          allDevices={allDevices}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onDeleted={() => {
            setEditing(null);
            load();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
