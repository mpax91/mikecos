import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { FinanceDashboard as Data } from '../api/types';
import { useReportTabMeta } from '../contexts/TabsContext';
import { Ny529Dashboard } from '../components/Ny529Dashboard';
import { AdtDashboard } from '../components/AdtDashboard';
import { TmobileDashboard } from '../components/TmobileDashboard';
import { FiosDashboard } from '../components/FiosDashboard';
import { HanoverDashboard } from '../components/HanoverDashboard';
import { AllyDashboard } from '../components/AllyDashboard';
import { AmazonDashboard } from '../components/AmazonDashboard';
import { AmexBankDashboard } from '../components/AmexBankDashboard';
import { UsaaDashboard } from '../components/UsaaDashboard';
import { AmexCardDashboard } from '../components/AmexCardDashboard';
import { BofaCardDashboard } from '../components/BofaCardDashboard';
import { TargetCardDashboard } from '../components/TargetCardDashboard';
import { PaypalDashboard } from '../components/PaypalDashboard';
import { MerrillDashboard } from '../components/MerrillDashboard';
import { TspDashboard } from '../components/TspDashboard';

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
      : data.kind === 'tsp'
        ? [t.institution, 'Uniformed Services', data.summary.current.map((f) => f.fund).join(' + '), data.summary.contributions.roth ? 'Traditional + Roth' : 'Traditional'].filter(Boolean).join(' · ')
      : data.kind === 'merrill'
        ? [t.institution, 'Investment Advisory Program', ...data.summary.accounts.map((a) => `${a.label} ••${a.last4}`), data.summary.chase ? `Chase UTMA ••${data.summary.chase.last4}` : null].filter(Boolean).join(' · ')
      : data.kind === 'adt'
        ? [t.institution, t.type, data.account?.accountLast ? `••${data.account.accountLast}` : null, data.summary.latest?.services].filter(Boolean).join(' · ')
        : data.kind === 'hanover'
          ? [t.institution, data.summary.policies.map((p) => p.label).join(' + '), data.summary.termEnd ? `Renews ${new Date(`${data.summary.termEnd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : null].filter(Boolean).join(' · ')
        : data.kind === 'fios'
          ? [t.institution, t.type, data.summary.plan, data.account?.account ? `Account ${data.account.account}` : null].filter(Boolean).join(' · ')
        : data.kind === 'tmobile'
          ? [t.institution, data.summary.plan, `${data.summary.lines.filter((l) => l.active).length} lines`, data.account?.account ? `Account ${data.account.account}` : null].filter(Boolean).join(' · ')
        : data.kind === 'ally'
          ? [t.institution, ...data.summary.accounts.filter((a) => a.open).map((a) => `${a.label} ••${a.last4}`)].join(' · ')
          : data.kind === 'amazon'
            ? [t.institution, t.type, data.account?.accountLast ? `Visa ••${data.account.accountLast}` : null, data.summary.purchaseApr !== null ? `${data.summary.purchaseApr}% APR` : null].filter(Boolean).join(' · ')
            : data.kind === 'amexCard'
              ? [t.institution, t.type, data.account?.accountEnding ? `Card ••${data.account.accountEnding.replace(/\D/g, '').slice(-5)}` : null, data.summary.purchaseApr !== null ? `${data.summary.purchaseApr}% APR${data.summary.onPenaltyApr ? ' (penalty)' : ''}` : null].filter(Boolean).join(' · ')
            : data.kind === 'bofaCard'
              ? [t.institution, t.type, data.account?.accountLast ? `${data.summary.cardType ?? 'Visa'} ••${data.account.accountLast}` : null, data.summary.purchaseApr !== null ? `${data.summary.purchaseApr}% APR${data.summary.onPenaltyApr ? ' (penalty)' : ''}` : null].filter(Boolean).join(' · ')
            : data.kind === 'targetCard'
              ? [data.summary.cardName, 'TD Bank USA', data.account?.accountLast ? `••${data.account.accountLast}` : null, '5% off at Target', data.summary.purchaseApr !== null ? `${data.summary.purchaseApr}% APR` : null].filter(Boolean).join(' · ')
            : data.kind === 'paypal'
              ? [t.institution, t.type, data.summary.balancePrinted ? `Balance ${data.summary.balance.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}` : null, data.summary.lastActivity ? `Last activity ${new Date(`${data.summary.lastActivity}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : null].filter(Boolean).join(' · ')
            : data.kind === 'amexBank'
              ? [t.institution, data.summary.label, data.summary.apy !== null ? `${data.summary.apy.toFixed(2)}% APY` : null].filter(Boolean).join(' · ')
            : data.kind === 'usaa'
              ? [t.institution, data.summary.product ?? t.type, data.summary.last4 ? `••${data.summary.last4}` : null].filter(Boolean).join(' · ')
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
      {data && data.statements.length > 0 && (data.kind === 'tsp' ? (
          <TspDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'merrill' ? (
          <MerrillDashboard data={data} onDismissFlag={dismiss} onReload={load} />
        ) : data.kind === 'adt' ? (
          <AdtDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'tmobile' ? (
          <TmobileDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'hanover' ? (
          <HanoverDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'fios' ? (
          <FiosDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'ally' ? (
          <AllyDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'amazon' ? (
          <AmazonDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'amexBank' ? (
          <AmexBankDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'usaa' ? (
          <UsaaDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'amexCard' ? (
          <AmexCardDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'bofaCard' ? (
          <BofaCardDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'targetCard' ? (
          <TargetCardDashboard data={data} onDismissFlag={dismiss} />
        ) : data.kind === 'paypal' ? (
          <PaypalDashboard data={data} onDismissFlag={dismiss} />
        ) : (
          <Ny529Dashboard data={data} onDismissFlag={dismiss} />
        ))}
    </div>
  );
}
