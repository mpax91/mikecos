# Template `bofaCard` — Bank of America Customized Cash Rewards (credit card)

Drive folder **Bank of America Credit Card** · files `BOA CC - YYYY.MM.DD.pdf`
(2014-06 → today, closing on the 26th since 2015, due the 23rd) · Household ·
account kind `card` · Vault entry **BofA Customized Cash Rewards** · Visa
Signature ••7614 (matched to the Wallet card by last 4). Started as the
BankAmericard Cash Rewards (2014–2016 statements say so); "Category Bonus"
cash back appears from 2020.

## Layout

Two eras, same content:

- **Era A (2014-06 → 2017-02)** — dotted leaders (`Previous Balance . . .
  $421.60`, `Fees Charged ......0.00`), dates `1/26/16`. The minus sign on
  credit lines is an unmapped glyph (U+0096), so the Payments line's sign
  comes from its label. Rewards block `Rewards`: `3.10 BASE EARNED THIS
  MONTH`, `3.10 BONUS THIS MONTH`, `46.49 REDEEMED`, `6.20 TOTAL AVAILABLE`.
  A few rows carry their ref/amount on a later line (after a 14-digit
  terminal id or `SALES TAX AMT 0.01`); a few 2014 rows print only the
  posting date.
- **Era B (2017-03 → today)** — `Previous Balance $ 426.00`, `New Balance
  Total -$ 63.28`, dates `09/26/2026`. `Your Reward Summary`: `1.02 Base Cash
  Back Earned`, `2.03 Category Bonus Earned`, `.33 Relationship Bonus
  Earned` (2019 also `Other Bonus Earned`), `273.14 Cash Back Redeemed`,
  `6.64 Total Cash Back Available`. In some PDFs (late 2020 – early 2021)
  the font maps the minus to the digit **6** (`… 4468 7614 6 23.59`, `6$
  328.62`) — accepted only when followed by a space or `$`.

Both: the period line `August 27 - September 26, 2026` (opening date),
`Statement Closing Date`, `Days in Billing Cycle`, Total Credit Line /
Available, Cash Credit Line / `for Cash`, `Payment Due Date`, `Total
Minimum Payment Due`, `Purchases 23.49%V` (era A promo layout puts the rate
two lines below), `Penalty APR of 29.99%`, `Total fees/interest charged in
YYYY`. Transactions are sections (Payments and Other Credits, Purchases and
Adjustments, Fees, Interest Charged) of `MM/DD MM/DD <desc> <ref> [<acct>]
[sign] <amount>` rows; the full card number prints on every page and only
its last 4 are kept.

Payment kinds: `BA ELECTRONIC PAYMENT` = Bank of America's scheduled
(AutoPay) payment, always exactly the previous statement balance → `autopay
true`; `ONLINE/MOBILE PAYMENT`, `PAY BY PHONE`, `PAYMENT THANK YOU` = manual.
`CASH REWARDS STATEMENT CREDIT` = reward redemption.

Not statements (Skipped by file name): year-end summaries `BOA CC - 2014.pdf`
… `2025.pdf`. The `BOA Cash Rewards Scorecard` Google Sheet isn't a PDF.

## Quiet months

Bank of America sends **no statement** for a month with no activity and a
$0 balance. A gap between a $0 closing balance and a $0 previous balance is
"quiet" — not flagged, listed in Change History. Cash back can still be
redeemed to a bank account then (Mar 2015: $25.13 left without a statement
credit) and counts as redeemed. Quiet: Mar 2015, Mar–Jun 2019, Jun 2021,
Jun–Jul 2023, Jun 2025–Apr 2026. The "no statement 10 days after the
expected closing" flag is skipped while the latest balance is $0.

## Report card (local workerd + D1, 2026-10-10)

| | |
|---|---|
| PDFs in folder | 129 monthly + 11 year-end summaries |
| Read | 127 statements, 0 unreadable |
| Duplicates | `2022.04.26` (= the 3/26/2022 statement) and `2022.08.26` (= 6/26/2022) |
| Missing from Drive | Apr 2022, Aug 2022 (the duplicate files sit where they should be) |
| In-statement checks | 751/751 (summary math; each section's rows = its summary line; available credit) |
| Cross checks | 238/238 (balance carries over; cash back available = previous + earned − redeemed) |
| Transactions | 1,205 |

Checks per statement: Summary adds up · Payments & credits match activity ·
Purchases & adjustments match activity · Fees match · Interest matches ·
Available credit adds up (non-credit balances) · cross: Previous balance
carries over · Cash back carries over.

## Data highlights

- $41,984 net spending since Jun 2014; cash back $1,197.55 earned (incl. a
  $101.48 sign-up bonus in Jul 2014), $1,190.91 redeemed, $6.64 available.
- Late fee $25 on 5/23/2015, refunded 5/29/2015. The 2022 year-to-date totals
  show another **$25 fee + $6.05 interest** that were on the missing April
  2022 statement — the summary folds year-to-date fees/interest into the
  year (`hiddenFees` / `hiddenInterest`), and the paid-in-full streak stops
  at a missing statement.
- Credit line $8,000 → $15,000 (11/2018) → $22,000 (2/2023) → $29,000
  (8/2024); purchase APR 19.99% → 23.49% (27 variable-rate moves).
- 92% of the last 12 payments by AutoPay; the latest (6/23/2026) was manual
  and left a credit balance (−$63.28 on 9/26/2026).

## Outputs

- Flags: unreadable / duplicate files, failed math, missing months (recent =
  `gap:` attention, older = one `gaps_old:` info), `missing_after:`, latest
  `interest:` / `fee:` / `carried:`, `penalty_apr:`, APR / limit changes
  (info), `utilization:` ≥ 30% (info), `credit_balance:` (info, dashboard
  only), `cardChargeFlags` (duplicate charges, price increases), payer flags.
- Billing → Payment Quick Facts + Bills & Due Dates (a credit balance is a
  $0 bill; `paid` = the next statement shows nothing carried).
- `meta.card` → Card Quick Facts; `meta.rewards` (`rewardsFromBofaCard`,
  exact per-statement cash back) → Finance Card Rewards + redeem reminder.
- Vault note "Account Details": Balance as of… / Cash Back / Spend by Year /
  Recent Statements / Fees & Interest / Change History.
- Dashboard `BofaCardDashboard.tsx`: stats, Spending by Statement, Spend by
  Year, Cash Back by Statement, Cash Back by Year (CardRewardsPanel), Top
  Merchants, Fees & Interest, Where the Cash Back Comes From (base /
  category / relationship by year), Payments (AutoPay share, streak, quiet
  and missing months), Transactions, Statements.
