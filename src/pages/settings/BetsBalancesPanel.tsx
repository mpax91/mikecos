import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { Bet, BetTransaction } from '../../api/types';
import { COMMON_SPORTSBOOKS, formatMoney, sportsbookBalances, todayLocalISODash, type SportsbookBalance } from '../../utils/bets';
import { Modal } from '../../components/Modal';

/** Settings' "set my real balance" screen for Bets (see the Bets
 * tracker's own Banking tab for the transaction log this writes into). A
 * sportsbook's balance is never stored directly (worker/migrations/
 * 0040_bet_workspace.sql) — it's always derived as deposits/withdrawals/
 * bonuses/adjustments plus net bet profit. So "set the balance to $X" here
 * doesn't overwrite anything; it works out the gap between what MikeOS
 * currently computes and what Mike says the real number is, and logs a
 * single dated 'adjustment' transaction for exactly that gap — the same
 * mechanism Banking's own "+ Transaction" already exposes, just without
 * making Mike do the subtraction himself. Every past bet/transaction stays
 * exactly as logged; this only ever adds one new correcting row. */
export function BetsBalancesPanel() {
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [transactions, setTransactions] = useState<BetTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // sportsbook name
  const [addingBook, setAddingBook] = useState(false);
  const [newBookName, setNewBookName] = useState('');

  function load() {
    Promise.all([api.listBets(), api.listBetTransactions()])
      .then(([b, t]) => {
        setBets(b);
        setTransactions(t);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    load();
  }, []);

  const balances = useMemo(() => {
    if (!bets || !transactions) return [];
    const computed = sportsbookBalances(bets, transactions);
    // Every book Mike actually uses shows up even before its first bet or
    // transaction, at $0 — otherwise setting an opening balance for a book
    // with no history yet has nowhere to click.
    const known = new Set(computed.map((b) => b.sportsbook));
    const extra = COMMON_SPORTSBOOKS.filter((b) => !known.has(b)).map(
      (sportsbook): SportsbookBalance => ({ sportsbook, deposited: 0, withdrawn: 0, bonuses: 0, adjustments: 0, betNet: 0, balance: 0 })
    );
    return [...computed, ...extra].sort((a, b) => a.sportsbook.localeCompare(b.sportsbook));
  }, [bets, transactions]);

  if (error) return <div className="empty-state">Couldn't load balances: {error}</div>;
  if (!bets || !transactions) return <div className="empty-state">Loading…</div>;

  return (
    <div className="settings-page__section">
      <div className="toolbar-row">
        <h2 className="settings-page__section-title">Bets Balances</h2>
        <button className="btn" onClick={() => { setAddingBook(true); setNewBookName(''); }}>
          + Add Sportsbook
        </button>
      </div>
      <p className="settings-page__section-hint">
        MikeOS works out each book's balance from the bets and transactions you've logged, not from a number stored
        here. Enter what the sportsbook's app actually shows and Save — that logs a single correcting transaction
        (visible in Bets → Banking) for the difference, so future bets and transactions keep adjusting it correctly
        from there. Use this any time tracking drifts from reality, not just for a fresh start.
      </p>

      {balances.length === 0 ? (
        <div className="empty-state">No sportsbooks yet — add one to set its starting balance.</div>
      ) : (
        <div className="manage-list">
          {balances.map((b) => (
            <div className="manage-row" key={b.sportsbook}>
              <div className="manage-row__body">
                <div className="manage-row__title">{b.sportsbook}</div>
                <div className="settings-page__section-hint" style={{ margin: 0 }}>
                  MikeOS shows {formatMoney(b.balance)}
                </div>
              </div>
              <div className="manage-row__actions">
                <button type="button" className="btn btn--ghost" onClick={() => setEditing(b.sportsbook)}>
                  Set Balance
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SetBalanceModal
          sportsbook={editing}
          currentBalance={balances.find((b) => b.sportsbook === editing)?.balance ?? 0}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {addingBook && (
        <Modal title="Add Sportsbook" onClose={() => setAddingBook(false)}>
          <input autoFocus placeholder="e.g. PrizePicks" value={newBookName} onChange={(e) => setNewBookName(e.target.value)} />
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setAddingBook(false)}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={!newBookName.trim()}
              onClick={() => {
                const name = newBookName.trim();
                setAddingBook(false);
                setEditing(name);
              }}
            >
              Next: Set Balance
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SetBalanceModal({
  sportsbook,
  currentBalance,
  onClose,
  onSaved,
}: {
  sportsbook: string;
  currentBalance: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = Number(amount);
  const delta = Number.isFinite(target) && amount.trim() !== '' ? target - currentBalance : null;

  async function handleSave() {
    if (!Number.isFinite(target) || amount.trim() === '') return setError('Enter the balance shown in the sportsbook app.');
    if (delta === 0) return onSaved(); // already matches — nothing to log
    setSaving(true);
    setError(null);
    try {
      await api.createBetTransaction({
        date: todayLocalISODash(),
        sportsbook,
        type: 'adjustment',
        amount: delta!,
        notes: 'Balance correction (Settings → Bets Balances)',
      });
      onSaved();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={`Set ${sportsbook} Balance`} onClose={onClose}>
      <div className="bets-form">
        <div className="settings-page__section-hint" style={{ margin: 0 }}>
          MikeOS currently shows {formatMoney(currentBalance)} for {sportsbook}.
        </div>
        <label className="bets-form__field">
          <span>Actual balance right now</span>
          <input autoFocus placeholder="250.00" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {delta != null && delta !== 0 && (
          <div className={`bets-form__preview ${delta >= 0 ? 'is-up' : 'is-down'}`}>
            Logs a {delta >= 0 ? '+' : ''}
            {formatMoney(delta)} adjustment to close the gap
          </div>
        )}
        {error && <div className="bets-form__error">{error}</div>}
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
