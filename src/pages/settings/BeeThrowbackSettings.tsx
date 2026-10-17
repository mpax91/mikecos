import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { BeeThrowbackSettings } from '../../api/types';

/** Settings → Bedford Bee → Throwback Thursday (worker/src/bee/throwback.ts). */
export function ThrowbackSettings() {
  const [s, setS] = useState<BeeThrowbackSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .getBeeThrowbackSettings()
      .then(setS)
      .catch(() => setMsg('Could not load Throwback settings.'));
  }, []);
  async function save() {
    if (!s) return;
    setBusy(true);
    setMsg(null);
    try {
      setS(await api.saveBeeThrowbackSettings(s));
      setMsg('Saved.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  const field = (key: keyof BeeThrowbackSettings, label: string, min: number, max: number) => (
    <label className="bee-gradeset__row">
      <span>{label}</span>
      <input type="number" className="bee-gradeset__num" min={min} max={max} value={s?.[key] ?? ''} onChange={(e) => s && setS({ ...s, [key]: Number(e.target.value) })} />
    </label>
  );
  return (
    <>
      <h3 className="settings-page__field-label">Throwback Thursday</h3>
      <p className="settings-page__section-hint">
        Bee → <Link to="/bee?tab=throwback">Throwback</Link> ranks older stories to reshare. “Pick This Week’s Bedford Bee Throwback Post” appears every Saturday and checks itself off when you pick one — change the
        day or turn it off in <Link to="/settings?cat=recurring">Recurring Tasks</Link>.
      </p>
      {s && (
        <div className="bee-gradeset">
          <div className="bee-gradeset__grid">
            {field('windowDays', 'This Time Last Year: ± Days', 1, 60)}
            {field('minAgeDays', 'Best Of: At Least This Many Days Old', 30, 1825)}
            {field('cooldownDays', 'Days a Reshared Story Sits Out', 0, 1825)}
          </div>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={save}>
            Save
          </button>
        </div>
      )}
      {msg && <p className="settings-page__section-hint">{msg}</p>}
    </>
  );
}
