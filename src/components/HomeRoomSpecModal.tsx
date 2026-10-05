import { useMemo, useState } from 'react';
import type { HomeRoom } from '../api/types';
import { formatFeetInches } from '../lib/homeUnits';
import { pointAlongWall, inwardNormal, wallSegment } from '../lib/homeGeometry';
import { ROOM_SPEC_GUIDE, solveRoomSpecText, type SolvedRoom } from '../lib/roomSpec';
import { Modal } from './Modal';

/** Import a room from a room spec (src/lib/roomSpec.ts) — paste JSON or
 * load a .json file, see the solved room drawn to scale with any closure
 * errors before committing. Two modes: a brand-new room on the floor, or
 * "Replace shape" on an existing room (keeps its id, position, fixtures;
 * replaces its walls and doors/windows). */
export function HomeRoomSpecModal({
  room,
  initialText,
  onImport,
  onClose,
}: {
  room?: HomeRoom;
  initialText?: string;
  onImport: (solved: SolvedRoom, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [nameOverride, setNameOverride] = useState<string | null>(room ? room.name : null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const solved = useMemo(() => solveRoomSpecText(text), [text]);
  const name = nameOverride ?? solved.name ?? '';
  const canImport = solved.ok && name.trim().length > 0 && !saving;

  async function loadFile(file: File) {
    setText(await file.text());
  }

  function copyGuide() {
    navigator.clipboard.writeText(ROOM_SPEC_GUIDE).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  }

  async function submit() {
    if (!canImport) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onImport(solved, name.trim());
    } catch (e) {
      setSaveError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={room ? `Replace shape of "${room.name}"` : 'Import a room from a spec'} onClose={onClose} className="home-spec-modal">
      <div className="wallet-editor__hint">
        Describe the room as a walk around its walls — lengths, the turn at each corner, curves as arcs — and it's drawn exactly to scale. Get one from an AI by pasting it the{' '}
        <button type="button" className="home-spec-modal__link" onClick={copyGuide}>
          {copied ? 'instructions (copied)' : 'spec instructions'}
        </button>{' '}
        with your photos and measurements.
      </div>

      <div className="home-spec-modal__body">
        <div className="home-spec-modal__input">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} spellCheck={false} placeholder='{ "mikeos_room_spec": 1, "walls": [ … ] }' />
          <label className="btn btn--ghost btn--sm home-spec-modal__file">
            Load .json file
            <input type="file" accept=".json,application/json,text/plain" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} hidden />
          </label>
        </div>
        <div className="home-spec-modal__preview">
          {solved.points.length > 0 ? <SpecPreview solved={solved} /> : <div className="home-spec-modal__empty">Preview appears here</div>}
          {solved.points.length > 0 && (
            <div className="home-spec-modal__stats">
              {formatFeetInches(solved.width)} × {formatFeetInches(solved.depth)} · {(solved.area / 144).toFixed(0)} sq ft · {solved.wallEdges.length} walls · {solved.wallItems.filter((w) => w.type === 'door').length} doors ·{' '}
              {solved.wallItems.filter((w) => w.type === 'window').length} windows
              {solved.ceilingHeight ? ` · ${formatFeetInches(solved.ceilingHeight)} ceiling` : ''}
            </div>
          )}
        </div>
      </div>

      {solved.errors.length > 0 && text.trim() && (
        <ul className="home-spec-modal__messages home-spec-modal__messages--error">
          {solved.errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {solved.warnings.length > 0 && (
        <ul className="home-spec-modal__messages">
          {solved.warnings.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      {!room && (
        <label className="wallet-editor__field">
          <span>Room name</span>
          <input value={name} onChange={(e) => setNameOverride(e.target.value)} placeholder="From the spec's name" />
        </label>
      )}
      {room && <div className="wallet-editor__hint">Replaces this room's walls and its doors/windows. Furniture and other fixtures stay where they are — nudge them if the new shape moved things.</div>}
      {saveError && <div className="home-spec-modal__messages home-spec-modal__messages--error">{saveError}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={submit} disabled={!canImport}>
          {saving ? 'Saving…' : room ? 'Replace shape' : 'Import room'}
        </button>
      </div>
    </Modal>
  );
}

/** The solved room drawn to scale, walls labeled by their spec ids. */
function SpecPreview({ solved }: { solved: SolvedRoom }) {
  const { points, width, depth } = solved;
  const pad = Math.max(width, depth) * 0.1 + 6;
  const label = Math.max(width, depth) * 0.045;
  return (
    <svg className="home-spec-modal__svg" viewBox={`${-pad} ${-pad} ${width + pad * 2} ${depth + pad * 2}`} preserveAspectRatio="xMidYMid meet">
      <polygon points={points.map((p) => `${p.x},${p.y}`).join(' ')} className="home-room__fill" />
      <polygon points={points.map((p) => `${p.x},${p.y}`).join(' ')} className="home-spec-modal__outline" />
      {solved.wallItems.map((w, i) => {
        const a = pointAlongWall(points, w.wallIndex, w.offset);
        const b = pointAlongWall(points, w.wallIndex, w.offset + w.width);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={w.type === 'door' ? 'home-spec-modal__door' : 'home-spec-modal__window'} />;
      })}
      {solved.wallEdges.map((w) => {
        const mid = w.edges[Math.floor(w.edges.length / 2)];
        if (mid === undefined) return null;
        const seg = wallSegment(points, mid);
        const { nx, ny } = inwardNormal(points, mid);
        const t = w.edges.length % 2 === 0 ? 0 : seg.length / 2;
        const at = pointAlongWall(points, mid, t);
        return (
          <text key={w.id} x={at.x - nx * label * 1.3} y={at.y - ny * label * 1.3} fontSize={label} textAnchor="middle" dominantBaseline="central" className="home-spec-modal__label">
            {w.id}
          </text>
        );
      })}
    </svg>
  );
}
