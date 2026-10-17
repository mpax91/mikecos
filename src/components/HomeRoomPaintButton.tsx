import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { HomePaint } from '../api/types';
import type { RoomOption } from './HomeNetworkDeviceModal';
import { HomePaintModal } from './HomePaintModal';
import { PaintEntry } from './HomePaintPage';
import { Modal } from './Modal';

/** Room view → "🎨 Paint (N)": this room's paint colors (Home → Paint), with
 * Add Paint prefilled to the room. */
export function HomeRoomPaintButton({ roomId, roomName, rooms }: { roomId: string; roomName: string; rooms: RoomOption[] }) {
  const [paints, setPaints] = useState<HomePaint[] | null>(null);
  const [allPaints, setAllPaints] = useState<HomePaint[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<HomePaint | 'new' | null>(null);

  const load = useCallback(() => {
    api
      .listHomePaints(roomId)
      .then(setPaints)
      .catch(() => setPaints([]));
  }, [roomId]);

  useEffect(() => {
    load();
  }, [load]);

  function openList() {
    setOpen(true);
    // Every room's paint feeds the editor's suggestions and Same As.
    api
      .listHomePaints()
      .then(setAllPaints)
      .catch(() => {});
  }

  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={openList} title="Paint colors used in this room">
        🎨 Paint{paints?.length ? ` (${paints.length})` : ''}
      </button>

      {open && !editing && (
        <Modal title={`Paint · ${roomName}`} onClose={() => setOpen(false)}>
          {!paints ? (
            <div className="empty-state">Loading…</div>
          ) : paints.length === 0 ? (
            <div className="home-net__muted" style={{ fontSize: 13 }}>
              No paint recorded for this room yet.
            </div>
          ) : (
            <div className="home-paint-room home-paint-room--flat">
              {paints.map((p) => (
                <PaintEntry key={p.id} p={p} onClick={() => setEditing(p)} />
              ))}
            </div>
          )}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setOpen(false)}>
              Done
            </button>
            <button className="btn" onClick={() => setEditing('new')}>
              + Add Paint
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <HomePaintModal
          paint={editing}
          defaults={{ roomId }}
          rooms={rooms}
          allPaints={allPaints}
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
