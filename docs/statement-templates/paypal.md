# PayPal — template `paypal`

Drive folder **"PayPal"**, files `PayPal - YYYY.MM.pdf`, **2011-05 → today
(165 PDFs)**. Owner: Household. Kind: **`app`** (payment app — new
2026-10-12). PayPal only sends a statement for a month with activity, so
missing months are normal ("quiet"), not gaps.

## What the account is (Mike, 2026-10-12)
A pass-through: payments to stores/people are funded at the moment of
payment by a card or bank (inline line under the payment, or a separate
"General Credit Card Deposit" row whose Ref ID = the payment's ID); money
received lands in the balance (minus PayPal's fee) and is withdrawn to the
bank. The balance is almost always $0. Finance counts the balance toward
Household (so only when money is actually sitting there); it is never a
bill or a card. The dashboard is about activity.

## Layouts
| Layout | Files | How it reads |
|---|---|---|
| legacy | 2011 → 2017 | `M/D/YYYY USD amt fee total Description`; funding as `60.00 USD USAA Checking - Checking x-9190` or a separate `Charge From Credit Card` / `Add Funds from a Bank Account` row (paired by same day + amount — no Ref IDs). Balance block is columnar (labels, then currency, then values). 2012 has GBP rows (listed, not summed). |
| classic | 2018 → 2019-03 | `Account Statement \| June 2018`; `Beginning/Ending Balance`; rows `MM/DD/YYYY Type: Name`, funding line `Visa x-0139 26.70 USD`, `ID:`, `Ref ID:`, then `USD amount fee total`. |
| activity | 2019-04 → ~2021 | "a view of all PayPal account activity" — same rows, **no balance printed**. |
| twoPart | → today | "two statements": PayPal account activity, then the PayPal Balance account (Available beginning/ending, fees this period/YTD) repeating balance rows — only the first part is read. |

Quirks handled: dates wrapping a line (`08/08/202` / `3`); bank names
wrapping (`USAA FEDERAL SAVINGS BANK -` / `Checking x-9190 184.74` / `USD`);
discount lines (`eBay Coupon 5.00 USD`, `… Special offer 5.00 USD`,
`CURP Card 5.67 USD` = PayPal rewards); PayPal credits (`MSB Redemption`
with Ref ID = the payment); refunds sent back to the card (`General Credit
Card Withdrawal` sharing the refund's Ref ID); canteen-vending `Other` rows.

## Row classes
purchase (store) · payment (sent to a person: General/Mobile Payment,
Payment Sent) · received · refund · reward (PayPal credits) · withdrawal
(to bank) · add_funds · funding (hidden — the card/bank behind another
row) · card_return. Stored transactions: purchase, payment, deposit
(received), refund, reward, withdrawal, transfer_in/out, plus a separate
`fee` row for each PayPal fee.

## Checks
Per statement: every row's amount + fee = total; the balance carries
(beginning + each row's balance effect = ending, where the effect is the
row total minus inline outside funding); every payment is fully funded
(card/bank/balance/credits = amount paid). Across statements: a printed
ending carries to the next printed beginning.

## Report card (2026-10-12)
Local workerd: all **103** PDFs 2018-01 → 2026-09 read, every check passes
(492 transactions). Two legacy files (2012-06 GBP, 2015-02) tested from
hand-rebuilt PDFs; the other ~60 2011–2017 files are under 25 KB, which
the Drive connector can't hand over cheaply — the live scan reads them and
any failure is flagged with its reason.

## Outputs
- Finance row: `app` headline (balance + paid out in the last 12 months).
- Dashboard (`PaypalDashboard.tsx`, on the dashboard kit): range picker,
  tiles Paid Out / Received / Refunds / To Bank / PayPal Fees (vs previous
  range, tap → sheet), Paid Out by month/year, Subscriptions, How It Was
  Paid, Stores, People, By Year, Activity (cards on phones, tap → row
  sheet), Statements.
- **Card matching** (`paypalMatch.ts`): card-funded PayPal payments are
  matched to live card statements' `PAYPAL *…` lines (same amount, posted
  0–5 days later). Card dashboards show "via PayPal · <store>" and a "Paid
  Through PayPal" panel; the PayPal dashboard shows which card actually
  paid. Computed on read, nothing stored.
- Flags: `idle:` money left in PayPal (attention), `fee:` fee on the latest
  statement (attention), `price_up:` subscription went up (attention),
  `sub_new:` new subscription (info), `gap:YYYY-MM` a live card shows PayPal
  charges in a month with no PayPal statement (attention while recent —
  the only way to know a month is really missing), plus file/dup/check.
- Vault "PayPal": facts Type + Customer Service; note "Account Details"
  (Latest Statement, Subscriptions, How PayPal Is Funded, Activity by Year,
  Recent Statements); links PayPal / Finance Dashboard / Drive Folder.
- Tax Packet "PayPal": money received (by sender, with fees) this year and
  last, with a pointer to check for a 1099-K.
- Subscriptions = PayPal "Subscription Payment" rows, or the same price on
  3+ charges (≥60%) on a monthly/yearly schedule. "PreApproved Payment" is a
  saved billing agreement, not a subscription.
