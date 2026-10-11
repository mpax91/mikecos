import { SectionPicker } from '../components/dash/SectionPicker';
import { useUrlRange } from '../components/dash/useUrlRange';
import { BEE_START } from '../utils/dateRange';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BeeSearchSection } from '../components/BeeSearchSection';
import { BeeWebsiteSection } from '../components/BeeWebsiteSection';
import { BeeBingSection, BeeClaritySection } from '../components/BeeMicrosoftSections';
import { BeeSocialSection } from '../components/BeeSocialSection';
import { BeeSubstackSection } from '../components/BeeSubstackSection';
import { BeeReviewSection } from '../components/BeeReviewSection';
import { api } from '../api/client';
import type { BeeSubstack } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';

/** Insights → Bedford Bee: Social, Substack, SEO, Website and Year in Review
 * tabs sharing one date range (`useUrlRange`). The Substack payload loads
 * here because Scan Now lives on this page. */

export function BeePage() {
  useReportTabMeta('Bee', 'bee');
  const [data, setData] = useState<BeeSubstack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const [range, setRange] = useUrlRange(BEE_START);
  const tab = tabParam === 'search' || tabParam === 'website' || tabParam === 'substack' || tabParam === 'review' ? tabParam : 'social';

  const load = useCallback(() => {
    api
      .getBeeSubstack()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function scan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const r = await api.scanBee();
      setScanMsg(r.errors.length ? r.errors.join(' · ') : r.read ? `Read ${r.read} new file${r.read === 1 ? '' : 's'}.` : 'Up to date — no new files.');
      load();
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="bee-page">
      <div className="links-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          Bedford Bee
        </h1>
        <Link to="/settings?cat=bee" className="settings-gear-link" title="Bedford Bee Settings" aria-label="Bedford Bee Settings">
          ⚙️
        </Link>
      </div>
      <SectionPicker
        className="bee-sources"
        label="Source"
        value={tab}
        onChange={(key) =>
          setParams(
            (prev) => {
              const p = new URLSearchParams(prev);
              if (key === 'social') p.delete('tab');
              else p.set('tab', key);
              return p;
            },
            { replace: true },
          )
        }
        options={[
          ['social', 'Social'],
          ['substack', 'Substack'],
          ['search', 'SEO'],
          ['website', 'Website'],
          ['review', 'Year in Review'],
        ]}
      />
      {tab === 'social' ? (
        <BeeSocialSection range={range} setRange={setRange} />
      ) : tab === 'review' ? (
        <BeeReviewSection />
      ) : tab === 'search' ? (
        <>
          <BeeSearchSection />
          <BeeBingSection />
        </>
      ) : tab === 'website' ? (
        <>
          <BeeWebsiteSection />
          <BeeClaritySection />
        </>
      ) : (
        <>
          {error && <p className="fin-dash__muted">{error}</p>}
          {!data && !error && <p className="fin-dash__muted">Loading…</p>}
          {data && <BeeSubstackSection data={data} range={range} setRange={setRange} onScan={scan} scanning={scanning} scanMsg={scanMsg} />}
        </>
      )}
    </div>
  );
}
