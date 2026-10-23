# Lowe's Credit Card (`lowesCard`)

Drive folder **Lowe's Credit Card** · files `Lowe's Credit Card - YYYY.MM.pdf` · issuer **Synchrony Bank**
(Lowe's Advantage Card, renamed **MyLowe's Rewards Credit Card** in 2024). Account kind `card`, owner Household.

## How the folder is kept

The card is used a few times a year. Only statements for a cycle **with purchases** are saved. The
"payment-only" statement Synchrony sends the next month (payment + $0 balance) is not kept. So:

- every saved statement normally opens at $0;
- months between saved statements are **quiet** — never flagged as missing;
- a month is only "missing" when a later saved statement opens with a balance (the months between
  had a balance → `gap:YYYY-MM`).

## Layout (one era, Synchrony, clean pdf.js text)

| Field | Text |
| --- | --- |
| Previous balance | `Previous Balance as of MM/DD/YYYY $x` |
| Payments / credits | `Payments - x`, `Other Credits - x` |
| Purchases | `Purchases/Debits + x` |
| Fees / interest | `Fees Charged + x`, `Interest Charged + x` |
| New balance / closing | `New Balance as of MM/DD/YYYY $x` |
| Cycle | `NN Day Billing Cycle from MM/DD/YYYY to MM/DD/YYYY` (opening date; the day count isn't checked — printed "32" for a 31-day cycle once) |
| Due / minimum | `Payment Due Date: MM/DD/YYYY`, `Total Minimum Payment Due: $x` |
| Limit | `Credit Limit $x`, `Available Credit $x` (not checked — rounded, reflects pending) |
| Last 4 | `Account Number ending in 022 6` (digits spaced) |
| APR | `Regular Purchases N/A 26.99% …` |
| Change in terms | `CHANGE-IN-TERMS NOTICE` / "your APR is increasing" → `termsNotice`, `noticeApr` = highest "at an APR of X%" quoted |
| YTD | `YYYY Year- to- Date Fees and Interest` → Total Fees Charged / Total Interest Charged / Total Interest Paid |
| Balance types | Account Balance Summary rows: `Regular …`, promo rows, `Total …` — last column = new balance (`-` = 0). Any row other than Regular/Total = a promotional (deferred-interest) balance. |

**Transactions:** rows `MM/DD [ref] DESC $amt` / `-$amt` under section heads. Item lines printed
under each purchase are kept as `purchaseDetail[].items` (department / product names, Title-Cased).
`PROMOTIONAL DISCOUNT` → `discount: true` (the card's 5%), `FREIGHT SALES…` / `PARCEL` → `shipped: true`.
`LOWES INTERNET FUFILLMNT` = online; `STORE 3360 YORKTOWN NY` = in store ("Yorktown NY (#3360)").
`INTEREST CHARGE ON PURCHASES $0.00` rows are dropped.

## Checks

Per statement: summary adds up; payments & credits match rows; purchases match rows; fees match;
interest matches; page-1 balance = summary; balance types add up. Cross (derive): previous balance
carries over (back-to-back cycles only); YTD fees / interest never go down within a year.

**Report card (2026-10-23):** 8/8 PDFs (2021-07 → 2026-07) read in workerd, 56/56 in-statement checks.

## Payment proof (`lowesCardSummary.ts`)

Because payment-only statements aren't kept, each balance's payment is proven by, in order:

1. **checking** — a payment in the live USAA Checking folder whose description matches
   `LOWES|SYF|SYNCHRONY|SYNCB` for exactly the balance, between closing and due + 20 days (gives the
   date → on time or not). A USAA derive re-derives the Lowe's folder.
2. **statement** — the next cycle was kept and shows the payment.
3. **next_zero** — a later kept statement opens at $0. On time when that statement is in the same
   calendar year and its YTD fees show nothing beyond fees on kept statements.

A later statement opening with a balance = **carried**. The latest statement with no proof is
`due` until the due date, then `unconfirmed`. The Finance row's Card Balances value is what's still
owed (0 once proven), and Bills gets `paid` from the same proof.

## Savings (estimated)

The 5% comes off at checkout (not tax / shipping) and is never printed. Estimate =
charged × 5/95 ÷ 1.08375 (Westchester sales tax). "Vs a 2% card" = that − 2% of the same spend.
`rewardsFromLowesCard`: label "Savings (est.)", nothing to redeem, every year `partial`.

## Flags

| Key | Severity | Attention | When |
| --- | --- | --- | --- |
| `file:` / `dup:` / `check:` | warn / info | — | standard |
| `unconfirmed:<closing>` | warn | **yes (new prefix)** | latest balance > 5 days past due, nothing proves payment |
| `gap:YYYY-MM` | warn | recent only | a balance carried into a later kept statement |
| `interest:` / `fee:` / `carried:` | warn | yes | on the latest statement |
| `fee:ytd:<year>` / `hidden_fee:<year>` | warn / info | current+last year only | YTD fees/interest exceed what kept statements show |
| `promo:<closing>` | warn | **yes (new prefix)** | a deferred-interest promo balance on the latest statement |
| `terms:` / `change:apr:` / `change:credit_line:` | info | — | on the latest statement |
| `dormant:<last purchase>` | info | — | no purchase for 12+ months (Synchrony can close idle store cards) |
| `utilization:` / `credit_balance:` | info | — | standard |
| `dup_charge:` / payer | via `cardChargeFlags` / `payerFlags` | | |

## Outputs

Vault "Lowe's Credit Card" (seeded facts Card / Perk / Customer Service; auto note "Account Details":
Latest Statement, Savings, What You Bought, Statements, Change History). Card facts with
`statementRewards` 5% at Lowe's. Tax Packet: nothing.

Dashboard (`kind 'lowesCard'`): tiles Spent / Saved (Est.) / Owed Now / Last Used; What You Bought;
Where It Went (rule categories); Latest Statement; Worth Knowing; Spend & Savings by Year;
Statements with a "Paid?" column. Sheets for every tile, purchase, category, year and statement.
