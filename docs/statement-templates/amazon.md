# Amazon Prime Visa — template `amazon`

Drive folder **"Amazon Prime Credit Card"**, files `Amazon - YYYY.MM.DD.pdf`,
one per month closing on the 17th, **2014-09 → 2026-09 (145 monthly PDFs, no
missing months)**, plus four year-end "Annual Summary" PDFs (`Amazon - 2014.pdf`
… `2017.pdf`, skipped by file name) and a Google Sheet ("Amazon Prime Rewards
Scorecard", not a PDF — ignored). Owner: Household. Kind: **`card`** (new):
the statement balance is owed, so Finance keeps it out of the Household total
and sums it as **Card Balances**.

Card: Chase Visa ••6986 (only the last 4 are ever stored). Product history:
"Amazon.com Rewards Visa" (3% back at Amazon) until the January 2017
statement, then the Prime card (5% back) — "YOUR PRIME VISA POINTS" wording
from 2023.

## Layout (one Chase layout for the card's whole life)
- ACCOUNT SUMMARY: `Previous Balance`, `Payment, Credits`, `Purchases`
  (`+$x`, `+ $x` in 2016–19), `Cash Advances`, `Balance Transfers`, `Fees
  Charged`, `Interest Charged`, `New Balance`, `Opening/Closing Date MM/DD/YY
  - MM/DD/YY`, `Credit Access Line`, `Available Credit`, `Cash Access Line`,
  `Available for Cash`, `Past Due Amount`, `Balance over the Credit Access Line`.
- Coupon: `Payment Due Date: MM/DD/YY` (no colon in 2015-12), `Minimum
  Payment:` / `Minimum Payment Due:` (2023→).
- Points: `Previous points balance N`, `+ <category> N` lines (can be
  negative), `- Points redeemed this statement period N`, `[= ]Total points
  available for redemption N` (sometimes split over two lines).
- ACCOUNT ACTIVITY rows `MM/DD <merchant> <amount>` (amounts like `.72`);
  Amazon orders add an `Order Number …` line (kept on the description).
  Year comes from the closing date (rows dated after closing + 7 days belong
  to the prior year). LATE FEE / PURCHASE INTEREST CHARGE rows → fee /
  interest.
- **SHOP WITH POINTS ACTIVITY** rows (after a `… $ Amount Rewards` header)
  are Amazon orders paid with points at checkout — NOT card activity; kept in
  `values.shopWithPoints`, never in transactions or totals.
- INTEREST CHARGES: APR per balance type, `Total fees/interest charged in YYYY`.

Kinds stored: purchase · refund · payment · reward (REDEMPTION CREDIT) ·
adjustment (Statement Credit) · fee · interest · cash_advance.
`values.autopay` is true only when an "AUTOMATIC PAYMENT" row posts; all 139
payments so far are "Payment Thank You - Web" (manual), so `false`.
Do NOT add a `values.accounts[]` to this template — that shape feeds Wallet
*bank* suggestions.

## Report card (local workerd, unpdf 0.12, 2026-10-08)
| | |
|---|---|
| Statements read | **144 / 145** |
| Unreadable | `2015.11.17` — a printed/flattened copy: labels only, no figures (flagged; re-download from chase.com) |
| In-statement checks | **862 / 862** (summary adds up; payments & credits, purchases, fees and interest each match the activity rows; points add up) |
| Cross checks | **283 / 283** (previous balance and points carry over; consecutive statements only) |
| Transactions | 2,498 (+24 Shop With Points rows) |
| Not points-checked | `2017.04.17` — the 3%→5% product change's "Points transferred from other product" line doesn't net against the old balance (Chase's own numbers); the Jan 2017 carry-over (908 → 0) is skipped for the same reason |

History found: 4 late fees ($106: Oct 2014, Apr 2019, Aug 2021, Oct 2023),
$13.36 interest (Oct 2014, Apr 2019), $416.07 statement credits (2024–26);
31 purchase-APR moves (variable, 14.24% → 17.74%); cash line $1,700 → $425
(Oct 2020) → $1,700 (Nov 2024). Lifetime 326,690 points earned ($3,266.90),
$72,391 net spending; paid in full and on time for the last 35 statements.

## Outputs (`amazonDerive.ts`)
- Vault entry **"Amazon Prime Visa"**: seeded facts Card (Visa ••6986), Issuer,
  Customer Service; payment Quick Facts via `billingFromBills` (a card's
  "bill" = statement balance); note "Account Details" with owned sections
  Balance as of… / Rewards / Spend by Year / Recent Statements / Fees &
  Interest / Change History (APR moves summarized in one line); links Chase ·
  Amazon Prime Visa / Finance Dashboard / Drive Folder.
- Flags: unreadable/duplicate, failed math, missing month, no new statement
  10 days after the expected closing, interest / fee / carried balance /
  past due on the latest statement, APR / credit-line / cash-line / rewards
  change on the latest, utilization ≥ 30%, plus `payerFlags`.
- Task **"Pay Amazon Prime Visa ($X) by M/D/YYYY"** due on the due date (shows
  on the Calendar) — one per statement, skipped when on AutoPay (statement or
  the account's payer set to Auto-Pay); only created while the due date is
  ahead; an open one is cleared when the next statement arrives.
- Finance row: balance, "Due <date> · $X in points"; dashboard
  `AmazonDashboard.tsx` (stats, Spending by Statement, Spend by Year, Rewards
  Points, Points by Category, Top Merchants, Fees & Interest, Transactions —
  last 24 statements — and Statements with math + PDF links).
