# Thrift Savings Plan (`tsp`)

Drive folder **"Thrift Savings Plan"** — a uniformed-services TSP account. Files: `TSP - YYYY.Q#.pdf` (quarterly), `TSP - YYYY.pdf` (annual), `TSP - YYYY.MM[.DD].pdf` (on-demand). Balance account (`investment: true`), Household.

## Layouts (pdf.js text, no AI)

| Layout | Statements | Key anchors |
|---|---|---|
| a1 | 2004-Q4 → 2005-Q4 | `QUARTERLY PARTICIPANT STATEMENT`, `Oct 01, 2004 - Dec 31, 2004`; balances from TRANSACTION DETAIL BY SOURCE; fund rows `C Fund $88.48 18.48 …` (2005) or the per-fund detail sections |
| a2 | 2006-Q1 → 2012-Q1 | `PARTICIPANT STATEMENT For the period: MM/DD/YYYY – …`; `Total` row = begin, contributions, withdrawals, transfers, gain, end; election = the percent lines left after removing the balance mix |
| a3 | 2007 → 2011 annual | `ANNUAL PARTICIPANT STATEMENT For the year: YYYY`; ANNUAL ACTIVITY SUMMARY BY FUND (10 numbers per fund) |
| b1 | 2012-Q2 → 2022-Q1 | `Here's how the value of your TSP account…`, `Value on …` lines; quarterly summary tokens (6 money + 4 price/shares per fund); 12-month personal rate of return |
| b2 | 2012 → 2021 annual | `A Summary of Your Account Activity in YYYY`; Share Summary by Fund; fund performance table (letters line + names line, or 2020–21 rows); expenses; 2019+ also carries the Q4 summary |
| c | 2022-05 → today | new recordkeeper: `Account Summary MM-DD-YYYY to MM-DD-YYYY`, `Converted Balance` (05-26-2022), Activity Detail by Fund columns, Rates of Return (rows with/without YTD, or transposed on annuals), expense ratios |

Period keys: quarterlies = period end; annual = `<end>:annual`; on-demand = `<end>:interim`. Never stored: account number, SSN digits, date of birth, address, beneficiary names.

## Checks per statement
opening (+ converted) + contributions − withdrawals + gain = closing · funds add up to closing · shares × price = balance per fund · (2019–21 annuals) Q4 summary adds up and ends at the year-end balance.

## Report card (2026-10-22, local workerd)
102 PDFs 2004-Q4 → 2026-Q3: **101 read, 1 duplicate** (`TSP - 2005.Q4.pdf` is a copy of Q3 2005), **376/376 checks**. Time-weighted returns from the statements reproduce TSP's printed personal returns every year 2008–2025 and L 2040's printed 1/3/5-year returns (13.65 / 16.93 / 9.55 as of 9/30/2026).

## Outputs
Finance row (balance), Vault "Thrift Savings Plan" (auto note "Account & Performance"), flags (file/check/duplicate, `missing_after:` +135 d, `beneficiary:none` — attention, `gap:` / `gaps_old:`), Merrill Retirement tab's "Other retirement savings" defaults to the TSP balance. No Tax Packet lines (no withdrawals). Analysis: `tspSummary.ts`; dashboard `src/components/TspDashboard.tsx`.
