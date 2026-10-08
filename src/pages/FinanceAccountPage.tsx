import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { FinanceDashboard as Data } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { Ny529Dashboard } from '../components/Ny529Dashboard';
import { AdtDashboard } from '../components/AdtDashboard';
import { AllyDashboard } from '../components/AllyDashboard';
import { AmazonDashboard } from '../components/AmazonDashboard';

export function FinanceAccountPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useReportTabMeta(data?.folder.nickname ?? 'Finance', 'finance');

  const load = useCallback(() => {
    if (!id) return;
    api
      .getFinanceDashboard(id)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const t = data?.template;
  const subhead =
    !data || !t
      ? null
      : data.kind === 'adt'
        ? [t.institution, t.type, data.account?.accountLast ? `••${data.account.accountLast}` : null, data.summary.latest?.services].filter(Boolean).join(' · ')
        : data.kind === 'ally'
          ? [t.institution, ...data.summary.accounts.filter((a) => a.open).map((a) => `${a.label} ••${a.last4}`)].join(' · ')
          : data.kind === 'amazon'
            ? [t.institution, t.type, data.account?.accountLast ? `Visa ••${data.account.accountLast}` : null, data.summary.purchaseApr !== null ? `${data.summary.purchaseApr}% APR` : null].filter(Boolean).join(' · ')
          : [
            t.institution,
            data.account?.accountType,
            data.account ? `••${data.account.accountLast}` : null,
            data.account ? `Owner ${data.account.owner}` : null,
            data.account ? `Beneficiary ${data.account.beneficiary}` : null,
            data.summary.portfolio,
          ]
            .filter(Boolean)
            .join(' · ');
  const dismiss = (flagId: string) => {
    api.dismissStatementFlag(flagId).then(load);
  };

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
      {subhead && <p className="links-page__subhead">{subhead}</p>}

      {error && <div className="empty-state">Couldn’t load this account: {error}</div>}
      {!data && !error && <div className="empty-state empty-state--section">Loading…</div>}
      {data && data.statements.length === 0 && (
        <div className="empty-state">
          No statements read yet — run <strong>Scan Now</strong> in <Link to="/settings?cat=statements">Settings → Statements</Link>.
        </div>
      )}
      {data && data.statements.length > 0 && (data.kind === 'adt' ? (
          <AdtDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'ally' ? (
          <AllyDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'amazon' ? (
          <AmazonDashboard data={data} onDismissFlag={dismiss} />
        ) : (
          <Ny529Dashboard data={data} onDismissFlag={dismiss} />
        ))}
    </div>
  );
}
