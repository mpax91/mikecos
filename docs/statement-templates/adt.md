# ADT — Home Security (template `adt`)

Drive folder **ADT** (Household). Files `ADT - YYYY.MM.DD - Statement.pdf`,
monthly, Nov 2016 → today, plus one `ADT - 2017.07.18 - Contract.pdf`
(skipped by file name — `isStatementFile`). Code:
`worker/src/statements/templates/adt.ts` (parser + checks),
`adtSummary.ts` (pure summary), `adtDerive.ts` (Vault, flags, reminder),
dashboard `src/components/AdtDashboard.tsx`.

It's a **bill** account (`account.kind = 'bill'`): Finance shows its latest
bill and monthly cost, and it is left out of the balance total.

## Layout eras

| Era | Bills | Tells | Charges look like |
|---|---|---|---|
| A1 | 2016-11 → 2017-08 | `Invoice Date: 07/01/17`, no "at-a-glance" heading | `07/01/17 to 07/31/17 Security Services $52.99` |
| A2 | 2017-09 → 2020-07 | `Bill-at-a-glance`, `Services Summary` | `Invoice #T… 06/01/18 - 06/30/18` then `Security Services 56.78`; 2020: `SECURITY SERVICES* 08/01/20 - 08/31/20 $14.99` |
| B | 2020-08 → today | `Your Bill at-a-glance`, `Invoice date: / Service period:` | `Services* About your Services: …` then `Invoice Number … Oct 12 - Nov 11, 2026 $17.99` |

From ~2023 the B headings come out of pdf.js letter-spaced
(`I n v o i c e d a t e :`); `collapseSpacedLetters` joins runs of 4+
single characters before matching.

## Fields

- **Invoice date** → `periodStart = periodEnd` (one statement per invoice;
  two files with the same invoice date are duplicates).
- Bill-at-a-glance (first occurrence = page 1): Previous Balance (also
  `Previous Balance Credit`), Payments & / and Adjustments, Current
  Charges, Taxes and Fees, total (`Total Due`, `Total Amount Due`,
  `Upon Receipt`, `Do Not Pay`, `Your Credit Balance Is`,
  `Total Due (including pro-rate*)`). Signs as printed.
- Due date (A: row under `Account Number Due Date Amount Due`; B: line
  after `Your total due is:`), or a note: Upon Receipt / Do Not Pay /
  Past Due. Autopay when the bill says automatic payment.
- Payments/adjustments → transactions (`payment` / `adjustment`).
- Charge lines with service period; **monthly rate** = recurring
  monitoring lines covering a full month (27–31 days), pre-tax. Trip fees,
  installs and pro-rations are one-time / excluded.

## Checks

In-statement: Previous + Payments + Charges + Taxes = Total; itemized
payments = Payments and Adjustments; itemized charges = Current Charges;
itemized tax = Taxes and Fees. Cross-statement (bills ≤ 40 days apart):
prior Total = this Previous Balance.

## Outputs

- Vault **"ADT Home Security"**: seeded facts Account ••1558, Customer
  Service phone. Links MyADT, Finance Dashboard, Drive Folder. Auto note
  "Account Details" — owned sections *Current Bill as of …*, *Rate
  History*, *Spend by Year*, *Recent Bills* (last 12 with View links),
  *Change History*.
- Flags: unreadable/duplicate files, failed checks, past-due or carried
  balance on the latest bill, rate change on the latest bill, no new bill
  45 days after the last invoice.
- Task "Pay ADT Bill ($X) by <date>" only when the latest bill isn't on
  automatic payment (one per bill; cleared when the next bill arrives).
- No Tax Packet lines (not deductible).

## Report card (2026-10-06, local workerd)

- 117 PDFs: **115 read**, 1 skipped (contract), 1 unreadable
  (`2023.05.31` is an image-only scan).
- 3 duplicates (same invoice date): `2018.04.01` = `2018.03.01`
  (byte-identical), `2025.05.31` = `2025.03.31`, `2026.04.01` = `2026.03.31`.
  → 112 distinct bills.
- **445/445 in-statement checks** and **101/101 cross-statement checks**
  pass.
- Rate history: $48.99 (2016) → $52.99 → $56.78 (Jun 2018) → $60.57
  (Jul 2019) → $14.99 (Dec 2019) → $17.46 → $14.99 → $37.16 (2 services,
  Oct 2021) → $29.99 (Dec 2021, Burglar Alarm Monitoring) → $23.99
  (Jan 2024) → $28.94 (Jul 2026) → **$17.99** (Aug 2026, CO + Fire
  Monitoring).
- History worth knowing: a failed card in Feb 2018 left a ~$57–60
  balance carried on every bill through Nov 2019; one past-due bill in
  Mar 2024. 10 gaps of 45+ days between bills in Drive.
