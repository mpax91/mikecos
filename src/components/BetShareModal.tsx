import { useState } from 'react';
import type { Bet } from '../api/types';
import { betTitle, computeProfit, formatOdds, isMultiLegType, isUnsettled, legSummary, profitIfWin, resultLabel } from '../utils/bets';
import { formatUnits } from '../utils/betUnits';
import { copyText } from '../utils/clipboard';
import { Modal } from './Modal';

/** The text a shared slip carries — sizes in units only, never a dollar amount. */
export function unitSlipText(bet: Bet, unit: number): string {
  const multi = isMultiLegType(bet.bet_type) && bet.legs.length > 0;
  const risk = bet.wager / unit;
  const toWin = profitIfWin(bet) / unit;
  const lines = [`${betTitle(bet)} (${formatOdds(bet.odds)})`];
  if (multi) for (const l of bet.legs) lines.push(`• ${legSummary(l)}`);
  lines.push(`${formatUnits(risk)} to win ${formatUnits(toWin)}${bet.stake_type === 'free_bet' ? ' (free bet)' : ''}`);
  if (!isUnsettled(bet)) {
    const p = computeProfit(bet) / unit;
    lines.push(`${resultLabel(bet.result)}: ${p > 0 ? '+' : ''}${formatUnits(p)}`);
  }
  return lines.join('\n');
}

/** A single bet as a units-only slip to copy or share — what Mike sends
 * friends without revealing what he actually bet. */
export function BetShareModal({ bet, unit, onClose }: { bet: Bet; unit: number | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!unit) {
    return (
      <Modal title="Share in Units" onClose={onClose}>
        <p className="bets-share__empty">Log a cash pick first — your unit is the average of those.</p>
      </Modal>
    );
  }
  const text = unitSlipText(bet, unit);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const [first, ...rest] = text.split('\n');

  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Modal title="Share in Units" onClose={onClose} className="bet-slip-modal">
      <div className="bets-share">
        <div className="bets-share__card">
          <div className="bets-share__title">{first}</div>
          {rest.map((line, i) => (
            <div key={i} className={line.startsWith('•') ? 'bets-share__leg' : 'bets-share__line'}>
              {line}
            </div>
          ))}
        </div>
        <div className="bets-share__note">No dollar amounts — 1u is your unit when you placed this bet.</div>
        <div className="modal__actions">
          {canShare && (
            <button type="button" className="btn btn--ghost" onClick={() => navigator.share({ text }).catch(() => undefined)}>
              Share…
            </button>
          )}
          <button type="button" className="btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy Text'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
