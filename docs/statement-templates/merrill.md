# Merrill Lynch (`merrill`)

Folder **"Merrill Lynch"** — the monthly Merrill Lynch Investment Advisory Program package plus the custodial (UTMA) account's own statement.

## Files
- `Merrill Lynch - YYYY.MM.DD.pdf` — the monthly package: summary pages (Your Accounts, Balance Sheet, Portfolio Review, Income & Gain/(Loss) Review) then each linked account's statement (CMA, rollover IRA "IRRA", Roth "RRA"). Titled "Your Merrill Lynch Report" until early 2019, "Wealth Management Report" after; same layout.
- `Merrill Lynch - YYYY.MM.DD - Chase.pdf` — the UTMA's own monthly statement → period key `YYYY-MM-DD:chase` (so it never collides with the package of the same date).
- `… - Portfolio Review.pdf` / `Client Review` — skipped by name; one saved under a statement name is recognized (no Portfolio Summary) → NotAStatement.

## What's read (pdf.js text, regexes, no AI)
Per account: opening / credits / debits / securities transferred / market gains / closing (period + YTD), cash-flow lines (funds received, electronic transfers in/out, other credits/debits, checks, card/ATM, margin, advisory fees, dividends, buys, sells, trading fees), assets by type, strategy + sleeves + style-manager rates, objective, holdings (cash rows, money funds, equities, funds with Merrill's asset-class split), equity tax lots (Equity Cost Basis pages; kept for taxable accounts only), realized gains lot by lot (N/C = Merrill-marked wash sale), settled buys/sells (Unsettled Trades skipped — they settle next month), security transfers in/out, advisory fee lines (rebates negative), IRA rollover deposits by tax year, year-end value. Package pages add per-account income (taxable vs tax-exempt) and realized/unrealized gains, the market indicators, and the Net Portfolio Value.

Page ownership: pages split on pdf.js `+` page markers; a page belongs to the account whose "Account Number: 8XV-#####" it prints, summary pages carry "Primary Account", unmarked pages follow the page before. Holding rows are found from the PRICE (first 4-decimal number after a 2-decimal cost) so numbers inside names ("RUSSELL 2000", "20+ YEAR") stay in the name and 2018-era whole-share quantities still work; "(continued)" headings never cut a row; spin-off shares with N/A cost are kept.

## Checks
Per account: opening + activity = closing; assets add up; holdings add up (a gap becomes a "Not Itemized" row); tax lots match positions; fee lines = fees; trades = purchases & sales (return of capital / cash in lieu counted); realized lots = the summary. Package: accounts add up to Net Portfolio Value.

## Report card (Oct 2026, 98 PDFs)
95 statements read (Oct 2018 → Sep 2026 + one UTMA), 2 reviews skipped; **1,500 / 1,501 checks pass**. The one failure is Feb 2019, whose account pages are image-only — the package total still reads and that month's return uses it (info flag `partial:`).

## Analysis (merrillSummary.ts, on read)
Monthly Modified Dietz returns per account (external flows = deposits, transfers, checks, securities moved; dividends/fees stay inside), net and gross of the advisory fee, chained to YTD / 1 / 3 / 5-year / since-start. Benchmarks from `market_monthly` (migration 0142, Yahoo monthly adjusted closes, refreshed ≤ every 20h by the derive): S&P 500 (SPY) and a blend in the account's own start-of-month mix (US stocks VTI, international VXUS, bonds AGG, cash BIL); dollars vs benchmark with the same deposits. Fees (trailing-12 rate, by year), allocation (international by fund/stock name), merged holdings, taxes (by year from December YTD, losses harvested, harvest candidates ≥ $100 a position, cross-account wash sales — same-account ones are already on Merrill's 1099), and rule-based insights → advisor questions. Thresholds are constants at the top of merrillSummary.ts.

## Outputs
Vault "Merrill Lynch" (auto note "Accounts & Performance"), flags (`file:`, `check:`, `partial:`, `missing_after:` +45 days, `wash:` — an attention prefix — for possible wash sales in the last 75 days), Tax Packet section (realized gains, taxable income, harvested losses, 1099 timing, rollover 5498/1099-R note, UTMA kiddie-tax note). Finance: one Household row (IRA + Roth + CMA) and a separate "Merrill UTMA · Chase" row on Chase's tab (link `?tab=chase`), kept out of the Household total.
