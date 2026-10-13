# Verizon Fios (`fios`) — home internet bill

Drive folder **"Verizon Fios"** (also matches "Fios", "Verizon Fios Internet"),
files `Verizon Fios - YYYY.MM.DD.pdf`, one per month. Kind **bill**
(Household). Code: `worker/src/statements/templates/fios.ts`,
`fiosSummary.ts`, `fiosDerive.ts`, `src/components/FiosDashboard.tsx`.

## Layout

One Verizon layout from the first bill (Jan 2020) to today; only the
headings inside *Details of Charges* move around.

| Page | What's read |
| --- | --- |
| 1 | `Bill Date : September 11, 2026`, `Account Number:`, `Total Due by October 6 $x` (first bill: `Total Due by Feb 5, 2020 : $x`), `Auto Pay Scheduled` / `You're enrolled in auto pay`, `Auto pay date Oct 1` |
| 2 | *Your Discounts* table (`<plan> <price> -<discount> <you pay>`), `Discounts This Month -$x`, `$10 expires 1/11/23.` notes |
| 3 | *Details of Payments*: `Previous Balance`, `Payment Received - Thank You -x M/D`, `No Payment Received`, `Balance Forward $x` or `Past Due Pay Immediately $x`. *Details of Charges*: item lines `<desc> <amount> [M/D - M/D] [code]` under Services / Equipment / Discounts, a *Requested Change in Service* block (added / removed, pro-rated; descriptions can wrap onto the next line, e.g. `Fios Home Internet: 300 Mbps` / `removed 5/25 -28.33`), *Fees & Other Charges* or *Taxes* (sales tax, surcharges, late fee), `Subtotal [- 30 days] $x [M/D - M/D]`, `Charges $x`, `Total Due $x` |
| 4 | `… Price Guarantee … will not change through 5/23/27` |

Item kinds: service (the internet plan), equipment (`Rent: …`), discount,
addon (e.g. `Verizon Cloud 2 TB .00`, Disney+), change (pro-rations), tax,
fee (late payment). The plan line can already be net of a discount (the
*Your Discounts* row says so) — `discounts` adds that folded discount back.

## Checks

Per bill: previous balance + payments = balance forward; balance forward +
charges = total due; each subtotal = its lines (running sum resets at the
change and tax blocks — some *Taxes* blocks have no subtotal); `Charges` line
= itemized charges; page 1 total = details total. Across bills: last total =
this previous balance (≤ 40 days apart).

## Report card (2026-10-13)

81 of 81 PDFs (2020-01 → 2026-09) read in local workerd; 407 / 407 checks
pass (in-bill + cross); no gaps between bills. Three plans, one late fee
(the first months, before Auto Pay), one plan-change pro-ration month, the
Auto-Pay discount dropping off in 2024-01.

## Outputs

- Finance row: latest total due, regular monthly, status.
- Dashboard (`kind: 'fios'`): range picker; tiles Billed (range vs previous)
  / Monthly Now / Plan / Price Guarantee → sheets; Monthly Bill Over Time;
  Worth Knowing (price guarantee, Auto-Pay discount lost, included add-ons,
  discounts, late fees); Plan History; Spend by Year; Current Bill; Bills
  (cards on phones) → bill sheet with every line item and check.
- Vault entry "Verizon Fios": facts Account + Customer Service (seeded once);
  note Current Bill / Plan History / Spend by Year / Recent Bills / Change
  History; links My Verizon, Finance Dashboard, Drive Folder.
- Bills & Due Dates via `meta.billing`; payment Quick Facts.
- Home → Internet: `GET /api/statements/internet-bill` → one line above the
  Wi-Fi card (plan, monthly, Auto Pay, price lock, link to the dashboard).
- Tax Packet: nothing (home internet isn't deductible here).

## Flags

`file:` / `dup:` / `check:` as usual; `past_due:`; `fee:late:<date>` on the
latest bill; `plan:<date>` and `rate:<date>` (info) on the latest bill;
**`price_lock:<until>`** (warn, attention) within 90 days of the price
guarantee ending (`PRICE_LOCK_WARN_DAYS`); `autopay_discount:<date>` (info)
when the Auto-Pay discount stopped appearing; `missing_after:` 45 days after
the last bill; `highBillFlag`; payer flags.
