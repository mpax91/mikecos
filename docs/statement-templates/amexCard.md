# Template `amexCard` — American Express Blue Cash Everyday® (credit card)

Drive folder **American Express Credit Card** · files `AMEX CC - YYYY.MM.pdf`
(2019-08 → today, closing around the 27th/28th, due the 22nd) · Household ·
account kind `card` · Vault entry **Amex Blue Cash Everyday** · Wallet card
"AmEx Blue Cash Everyday" ••1003 (matched by last 4; Amex prints "Account
Ending 8-61003").

## Layout

One Amex layout for the card's whole life. What changes is the order
pdf.js returns the text in: some years (2023 especially) come out with
labels and values far apart. The parser only relies on:

- `Closing Date MM/DD/YY`, `Account Ending d-ddddd`
- `New Balance $x` (credit balance: `CR$x`), `Minimum Payment Due $x`,
  `Payment Due Date MM/DD/YY` (absent when nothing is due)
- Account Summary: five labels (Previous Balance, Payments/Credits, New
  Charges, Fees, Interest Charged) then their five values in order; same
  for Credit Limit / Available Credit and Cash Advance Limit / Available Cash
- `Reward Dollars` → a bare `29.10` within a few lines; `as of MM/DD/YYYY`
  (= the previous closing — Amex posts a cycle's cash back once its minimum
  payment is in)
- Activity rows: `MM/DD/YY[*] <merchant …>` with the amount at the end of the
  line or on its own line after 1–3 detail lines. Kinds: payment ("ONLINE
  PAYMENT - THANK YOU", AutoPay), reward ("YOUR CASH REWARD/REFUND IS"),
  refund, purchase, fee ("Late Payment Fee"), interest ("Interest Charge on
  Purchases")
- `Purchases <date> 16.74% (v)` / `Cash Advances …`, `Days in Billing
  Period: N` (opening date = closing − N + 1), `Total Fees/Interest in YYYY`,
  `Penalty APR of 29.99%` from the late-payment warning

Not statements (Skipped): `2020.05`, `2021.02`, `2021.03` are Amex notice
letters (terms changes) under a monthly name → `NotAStatement`; `AMEX CC -
2024.pdf` / `2025.pdf` year-end summaries → by file name.

## Report card (local workerd, 2026-10-09)

| | |
|---|---|
| PDFs in folder | 77 |
| Statements read | 72 / 72 |
| Skipped | 5 (3 notice letters, 2 year-end summaries) |
| In-statement checks | 432 / 432 (summary adds up, payments & credits, new charges, fees, interest vs rows; available credit) |
| Cross checks | 65 / 65 (previous balance carries over, consecutive months) |
| Transactions | 831 |

Checks: `Summary adds up`, `Payments & credits match activity`, `New
charges match activity`, `Fees match activity`, `Interest matches
activity`, `Available credit adds up`; cross: `Previous balance carries
over`.

## Facts from the history

- $17,205 net spending since Aug 2019; ~$455 cash back earned, $441
  redeemed as statement credits; 2.65% back over the last 12 statements.
- 2 late payment fees ($29, Oct 2023 and Nov 2025), $28.67 interest ever.
- Penalty APR 29.99% applied twice: Jan → Aug 2024 and Feb → Aug 2026.
- Missing from Drive: Feb–May 2020, Jan–Mar 2021, Aug–Sep 2021, Feb–Mar
  2022, Feb–Mar 2023, Mar 2024 (14 months; one info flag).

## Outputs

- Finance row (card: statement balance, due date, minimum, reward dollars)
  and `AmexCardDashboard` (stats, Spending by Statement, Spend by Year,
  Reward Dollars, Top Merchants, Fees & Interest, Penalty APR,
  Transactions, Statements with math + PDF links).
- Flags: unreadable/duplicate files, failed math, recent missing months
  (`gap:`), older gaps rolled into one info flag (`gaps_old:`), no statement
  10 days past the expected closing, interest / fee / carried balance on the
  latest, **penalty APR in effect** (`penalty_apr:`, warn, dashboard only),
  APR / credit-limit changes (info), utilization ≥ 30%, `cardChargeFlags`,
  payer flags.
- Payment Quick Facts + Bills & Due Dates via `meta.billing` (paid = next
  statement shows nothing carried) → "Pay Amex Blue Cash Everyday ($x)" on
  the 22nd unless Auto-Pay. Card Quick Facts via `meta.card` (no earn rates
  on the statement — Rewards comes from the Wallet card's Rewards card).
- Tax Packet: nothing (cash back isn't income).
