import type { Env } from '../types';
import { appOrigin } from '../statements/engine';
import { syncTaxPacketSection } from '../statements/taxPacket';
import { bold, bullets, para, text } from '../statements/vaultDoc';
import { loadStripe, moneyByYear } from './money';

/** "Bedford Bee (Substack)" section in each Tax Packet (this year and last):
 * gross paid subscriptions, each fee type, net, and what reached the bank.
 * Section key 'bee:substack' (taxPacket keeps 'bee:' keys alongside live
 * statement folders). */

export const BEE_TAX_KEY = 'bee:substack';
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function syncBeeTaxPackets(env: Env): Promise<void> {
  const txns = await loadStripe(env);
  if (!txns.length) return;
  const thisYear = Number(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 4));
  for (const y of moneyByYear(txns)) {
    if (y.year < thisYear - 1 || !y.charges) continue;
    const partial = y.year === thisYear;
    await syncTaxPacketSection(env, y.year, BEE_TAX_KEY, {
      title: 'Bedford Bee (Substack)',
      blocks: [
        bullets([
          [bold('Gross paid subscriptions: '), text(`${money(y.gross)} (${y.charges} charge${y.charges === 1 ? '' : 's'}: ${y.newSubs} new, ${y.renewals} renewal${y.renewals === 1 ? '' : 's'})`)],
          [bold('Substack fee (10%): '), text(money(y.substackFee))],
          [bold('Card processing (Stripe): '), text(money(y.processing))],
          [bold('Stripe Billing fees + tax: '), text(money(y.billingFee))],
          ...(y.refunds ? [[bold('Refunds: '), text(money(y.refunds))]] : []),
          ...(y.disputes ? [[bold('Disputes / adjustments: '), text(money(y.disputes))]] : []),
          [bold('Net: '), text(money(y.net))],
          [bold('Paid out to the bank: '), text(money(y.paidOut))],
        ]),
        para(
          `From Stripe’s balance history${partial ? ' — year to date, updates with each monthly export' : ''}. Fees are by charge date; Substack’s 10% and card processing are split out of Stripe’s combined fee.`
        ),
      ],
      expected: [],
      links: [
        { key: 'stripe', title: 'Stripe Dashboard', url: 'https://dashboard.stripe.com/balance' },
        { key: 'dashboard', title: 'Bedford Bee Dashboard', url: `${appOrigin(env)}/bee` },
      ],
    });
  }
}
