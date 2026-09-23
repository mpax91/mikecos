import { useMemo, useState } from 'react';
import type { Bet, BetTransaction, BetTransactionType } from '../api/types';
import { BET_TRANSACTION_TYPES } from '../api/types';
import { bankingTotals, formatMoney, sportsbookBalances } from '../utils/bets';
import { COMMON_SPORTSBOOKS } from '../utils/bets';
import { Modal } from './Modal';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';

function todayLocalISODash(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function transactionLabel(type: BetTransactionType): string {
  return BET_TRANSACTION_TYPES.find((t) => t.value === type)?.label ?? type;
}

function TransactionFormModal({
  transaction,
  onClose,
  onSave,
}: {
  transaction: BetTransaction | null;
  onClose: () => void;
  onSave: (params: Record<string, unknown>) => Promise<void>;
}) {
  const [date, setDate] = useState(transaction?.date ?? todayLocalISODash());
  const [sportsbook, setSportsbook] = useState(transaction?.sportsbook ?? '');
  const [type, setType] = useState<BetTransactionType>(transaction?.type ?? 'deposit');
  const [amount, setAmount] = useState(transaction ? String(Math.abs(transaction.amount)) : '');
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!sportsbook.trim()) return setError('Sportsbook is required.');
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) return setError('Amount must be a non-zero number.');
    // Adjustments can go either way; everything else is stored as a
    // positive magnitude (the type already says which direction it moves
    // the balance — see utils/bets.ts's sportsbookBalances).
    const signedAmount = type === 'adjustment' ? n : Math.abs(n);
    setSaving(true);
    setError(null);
    try {
      await onSave({ date, sportsbook: sportsbook.trim(), type, amount: signedAmount, notes: notes.trim() || undefined });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={transaction ? 'Edit Transaction' : 'Log a Transaction'} onClose={onClose}>
      <div className="bets-form">
        <label className="bets-form__field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="bets-form__field">
          <span>Sportsbook</span>
          <input list="bets-sportsbooks-txn" placeholder="DraftKings" value={sportsbook} onChange={(e) => setSportsbook(e.target.value)} />
          <datalist id="bets-sportsbooks-txn">
            {COMMON_SPORTSBOOKS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label className="bets-form__field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as BetTransactionType)}>
            {BET_TRANSACTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="bets-form__field">
          <span>Amount{type === 'adjustment' ? ' (negative to subtract)' : ''}</span>
          <input placeholder="100" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="bets-form__field">
          <span>Notes (optional)</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <div className="bets-form__error">{error}</div>}
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : transaction ? 'Save' : 'Log Transaction'}
        </button>
      </div>
    </Modal>
  );
}

export function BetsBankingTab({
  bets,
  transactions,
  onCreate,
  onUpdate,
  onDelete,
}: {
  bets: Bet[];
  transactions: BetTransaction[];
  onCreate: (params: Record<string, unknown>) => Promise<void>;
  onUpdate: (id: string, params: Record<string, unknown>) => Promise<void>;
  onDelete: (t: BetTransaction) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BetTransaction | null>(null);
  const [deleting, setDeleting] = useState<BetTransaction | null>(null);

  const balances = useMemo(() => sportsbookBalances(bets, transactions), [bets, transactions]);
  const totals = useMemo(() => bankingTotals(balances), [balances]);
  const sorted = useMemo(() => [...transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.created_at < b.created_at ? 1 : -1)), [transactions]);

  return (
    <div>
      <div className="dashboard-page__tiles">
        <div className="dashboard-page__tile card">
          <div className="dashboard-page__tile-label">Total Balance</div>
          <div className="dashboard-page__tile-value">{formatMoney(totals.totalBalance)}</div>
          <div className="dashboard-page__tile-aside">Across {balances.length} book{balances.length === 1 ? '' : 's'}</div>
        </div>
        <div className="dashboard-page__tile card">
          <div className="dashboard-page__tile-label">Deposited</div>
          <div className="dashboard-page__tile-value">{formatMoney(totals.deposited)}</div>
        </div>
        <div className="dashboard-page__tile card">
          <div className="dashboard-page__tile-label">Withdrawn</div>
          <div className="dashboard-page__tile-value">{formatMoney(totals.withdrawn)}</div>
        </div>
        <div className="dashboard-page__tile card">
          <div className="dashboard-page__tile-label">Net Deposited</div>
          <div className={`dashboard-page__tile-value ${totals.netDeposited >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(totals.netDeposited)}</div>
          <div className="dashboard-page__tile-aside">Deposits minus withdrawals</div>
        </div>
      </div>

      {balances.length > 0 && (
        <div className="bets-breakdown card">
          <div className="bets-breakdown__title">Balance by sportsbook</div>
          <div className="bets-breakdown__row bets-breakdown__row--head">
            <span>Sportsbook</span>
            <span>Deposited</span>
            <span>Withdrawn</span>
            <span>Bet net</span>
            <span>Balance</span>
          </div>
          {balances.map((b) => (
            <div key={b.sportsbook} className="bets-breakdown__row">
              <span className="bets-breakdown__name">{b.sportsbook}</span>
              <span>{formatMoney(b.deposited)}</span>
              <span>{formatMoney(b.withdrawn)}</span>
              <span className={b.betNet >= 0 ? 'is-up' : 'is-down'}>{formatMoney(b.betNet)}</span>
              <span className={`bets-breakdown__net ${b.balance >= 0 ? 'is-up' : 'is-down'}`}>{formatMoney(b.balance)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar-row" style={{ marginTop: 16 }}>
        <h2 className="heading-serif" style={{ fontSize: 18, margin: 0 }}>
          Transactions
        </h2>
        <button className="btn" onClick={() => setAdding(true)}>
          + Log Transaction
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">No deposits or withdrawals logged yet.</div>
      ) : (
        <div className="bets-log card">
          {sorted.map((t) => (
            <div key={t.id} className="bets-log__row">
              <div className="bets-log__main">
                <span className="bets-log__date">{t.date}</span>
                <span className="bets-log__pick">{t.sportsbook}</span>
                <span className="bets-log__meta">
                  {transactionLabel(t.type)}
                  {t.notes ? ` · ${t.notes}` : ''}
                </span>
              </div>
              <span className={`bets-log__profit ${t.type === 'withdrawal' ? 'is-down' : 'is-up'}`}>
                {t.type === 'withdrawal' ? '-' : t.amount < 0 ? '' : '+'}
                {formatMoney(Math.abs(t.amount))}
              </span>
              <KebabMenu
                items={[
                  { label: 'Edit', onClick: () => setEditing(t) },
                  { label: 'Delete', onClick: () => setDeleting(t), danger: true, separatorBefore: true },
                ]}
              />
            </div>
          ))}
        </div>
      )}

      {adding && (
        <TransactionFormModal
          transaction={null}
          onClose={() => setAdding(false)}
          onSave={async (params) => {
            await onCreate(params);
            setAdding(false);
          }}
        />
      )}
      {editing && (
        <TransactionFormModal
          transaction={editing}
          onClose={() => setEditing(null)}
          onSave={async (params) => {
            await onUpdate(editing.id, params);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete transaction?"
          body={`This ${deleting.date} ${transactionLabel(deleting.type).toLowerCase()} at ${deleting.sportsbook} will be permanently deleted.`}
          onConfirm={async () => {
            await onDelete(deleting);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
