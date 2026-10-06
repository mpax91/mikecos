import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Ny529Dashboard as Data } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { Ny529Dashboard } from '../components/Ny529Dashboard';

export function FinanceAccountPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useReportTabMeta(data?.folder.nickname ?? 'Finance', 'finance');

  const load = useCallback(() => {
    if (!id) return;
    api
      .getNy529Dashboard(id)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const t = data?.template;
  const a = data?.account;

  return (
    <div className="finance-page">
      <div className="breadcrumb">
        <button type="button" className="breadcrumb__back" onClick={() => navigate('/finance')} title="Back" aria-label="Back">
          ‹
        </button>
        <Link to="/finance" className="breadcrumb__link">
          Finance
        </Link>
        <span className="breadcrumb__sep">›</span>
        <span className="breadcrumb__current">{data?.folder.nickname ?? '…'}</span>
      </div>

      <div className="links-page__header">
        <h1 className="heading-serif" style={{ fontSize: 24, margin: '0 0 2px' }}>
          {data?.folder.nickname ?? 'Account'}
        </h1>
        <Link to="/settings?cat=statements" className="settings-gear-link" title="Statements Settings" aria-label="Statements Settings">
          ⚙️
        </Link>
      </div>
      {t && (
        <p className="links-page__subhead">
          {[t.institution, a?.accountType, a ? `••${a.accountLast}` : null, a ? `Owner ${a.owner}` : null, a ? `Beneficiary ${a.beneficiary}` : null, data?.summary.portfolio]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {error && <div className="empty-state">Couldn’t load this account: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {data && data.statements.length === 0 && (
        <div className="empty-state">
          No statements read yet — run <strong>Scan Now</strong> in <Link to="/settings?cat=statements">Settings → Statements</Link>.
        </div>
      )}
      {data && data.statements.length > 0 && (
        <Ny529Dashboard
          data={data}
          onDismissFlag={(flagId) => {
            api.dismissStatementFlag(flagId).then(load);
          }}
        />
      )}
    </div>
  );
}
