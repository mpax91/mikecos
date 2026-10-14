import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { BeeGradeConfig, BeeGradeKind, BeeGradeSettings } from '../../api/types';

/** Settings → Bedford Bee → Post Grades: the weights, cutoffs and windows
 * behind every A–F on the Bee dashboard (worker/src/bee/grades.ts). */
const KINDS: { key: BeeGradeKind; label: string }[] = [
  { key: 'fb', label: 'Facebook' },
  { key: 'ig', label: 'Instagram' },
  { key: 'substack', label: 'Substack' },
];
const INVERTED = new Set(['unfollows', 'unsubs']);

export function GradeSettings() {
  const [data, setData] = useState<BeeGradeSettings | null>(null);
  const [cfg, setCfg] = useState<BeeGradeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .getBeeGradeSettings()
      .then((d) => {
        setData(d);
        setCfg(d.config);
      })
      .catch(() => setMsg('Could not load grade settings.'));
  }, []);

  async function save(config: BeeGradeConfig | null) {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.saveBeeGradeSettings(config);
      setData(d);
      setCfg(d.config);
      setMsg(config ? 'Saved — grades update the next time the Bee dashboard loads.' : 'Back to the defaults.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const numIn = (value: number, on: (v: number) => void, label: string, step = 1) => (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={0}
      value={Number.isFinite(value) ? value : ''}
      aria-label={label}
      onChange={(e) => on(Number(e.target.value))}
      className="bee-gradeset__num"
    />
  );

  return (
    <>
      <h3 className="settings-page__field-label">Post Grades</h3>
      <p className="settings-page__section-hint">
        Every Facebook, Instagram and Substack post gets an A–F against the same platform’s posts from the {cfg?.baselineDays ?? 90} days before it.{' '}
        {data?.custom ? 'Using your own weights.' : 'Using the defaults.'}{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Adjust Weights & Cutoffs'}
        </button>
      </p>
      {open && cfg && data && (
        <div className="bee-gradeset">
          <h4 className="bee-gradeset__title">Grade Cutoffs (percentile among recent posts)</h4>
          <div className="bee-gradeset__grid">
            {(['A', 'B', 'C', 'D'] as const).map((l) => (
              <label key={l} className="bee-gradeset__row">
                <span>
                  <span className={`bee-grade bee-grade--${l.toLowerCase()}`}>{l}</span> at or above
                </span>
                {numIn(cfg.cutoffs[l], (v) => setCfg({ ...cfg, cutoffs: { ...cfg.cutoffs, [l]: v } }), `${l} cutoff`)}
              </label>
            ))}
            <p className="settings-page__section-hint bee-gradeset__full">Anything below D is an F. With the defaults that’s roughly A 10% · B 20% · C 35% · D 20% · F 15%.</p>
          </div>

          <h4 className="bee-gradeset__title">Baseline &amp; Timing</h4>
          <div className="bee-gradeset__grid">
            <label className="bee-gradeset__row">
              <span>Compare with posts from the last (days)</span>
              {numIn(cfg.baselineDays, (v) => setCfg({ ...cfg, baselineDays: v }), 'Baseline days')}
            </label>
            <label className="bee-gradeset__row">
              <span>Recent posts count double vs posts this many days older</span>
              {numIn(cfg.halfLifeDays, (v) => setCfg({ ...cfg, halfLifeDays: v }), 'Half-life days')}
            </label>
            <label className="bee-gradeset__row">
              <span>Too early to grade under (hours)</span>
              {numIn(cfg.minAgeHours, (v) => setCfg({ ...cfg, minAgeHours: v }), 'Too early hours', 0.5)}
            </label>
            <label className="bee-gradeset__row">
              <span>Facebook / Instagram grades settle at (hours)</span>
              {numIn(cfg.matureHours.social, (v) => setCfg({ ...cfg, matureHours: { ...cfg.matureHours, social: v } }), 'Social settle hours')}
            </label>
            <label className="bee-gradeset__row">
              <span>Substack grades settle at (hours)</span>
              {numIn(cfg.matureHours.substack, (v) => setCfg({ ...cfg, matureHours: { ...cfg.matureHours, substack: v } }), 'Substack settle hours')}
            </label>
          </div>

          {KINDS.map((k) => {
            const w = cfg.weights[k.key];
            const total = Object.values(w).reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
            return (
              <div key={k.key}>
                <h4 className="bee-gradeset__title">{k.label} Weights</h4>
                <div className="bee-gradeset__grid">
                  {Object.keys(data.defaults.weights[k.key]).map((m) => (
                    <label key={m} className="bee-gradeset__row">
                      <span>
                        {data.labels[k.key][m] ?? m}
                        {INVERTED.has(m) && <span className="settings-page__section-hint"> (counts against)</span>}
                        <span className="settings-page__section-hint"> · {Math.round(((w[m] ?? 0) / total) * 100)}%</span>
                      </span>
                      {numIn(w[m] ?? 0, (v) => setCfg({ ...cfg, weights: { ...cfg.weights, [k.key]: { ...w, [m]: v } } }), `${k.label} ${data.labels[k.key][m]} weight`)}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}

          <h4 className="bee-gradeset__title">Story Grade — Platform Weights</h4>
          <div className="bee-gradeset__grid">
            {KINDS.map((k) => (
              <label key={k.key} className="bee-gradeset__row">
                <span>{k.label}</span>
                {numIn(cfg.storyWeights[k.key], (v) => setCfg({ ...cfg, storyWeights: { ...cfg.storyWeights, [k.key]: v } }), `${k.label} story weight`)}
              </label>
            ))}
          </div>

          <div className="toolbar-row">
            <button className="btn btn--sm" onClick={() => save(cfg)} disabled={busy}>
              {busy ? 'Saving…' : 'Save Grades'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => save(null)} disabled={busy || !data.custom}>
              Reset to Defaults
            </button>
          </div>
        </div>
      )}
      {msg && <p className="settings-page__section-hint">{msg}</p>}
    </>
  );
}
