# Hanover Insurance (`hanover`)

**Folder:** "Hanover Insurance" (also matches "Hanover"). One folder for the whole
bundle — auto, home and umbrella — holding two kinds of PDF:

| Document | What's read | Period key |
|---|---|---|
| Billing notice ("Payment schedule" / "Withdrawal schedule") | statement date, bank account last 4, every scheduled withdrawal (total + a column per policy), installment fee, Recent activity, EFT enrollment text (→ Auto-Pay) | `YYYY-MM-DD:bill` |
| Auto declarations (new term or amended) | term, EFFECTIVE date, reason, total + per-vehicle premium, vehicles (VIN, mileage, additional insured), CSL / SUM / med pay, deductibles, full glass, accident-prevention discount per vehicle | `YYYY-MM-DD:auto` |
| Homeowners declarations | term (pdf.js splits the period box — end = start + 1 yr), Coverages A–F, deductible, standard + optional = total, mortgagee | `YYYY-MM-DD:home` |
| Umbrella declarations | term, AMENDMENT effective + reason, Old/New premium (new business: "Total 12 Month Policy Premium"), limit, excess UM/UIM, retained limit | `YYYY-MM-DD:umbrella` |

Documents share effective dates (an auto change triggers an umbrella change the
same day), so the period key carries the kind; the first 10 characters are always
the date (generic code slices them). Anything else Hanover-branded → NotAStatement
(Skipped); non-Hanover PDFs too.

Hanover sends **no monthly bill on EFT** — only a schedule when Auto-Pay starts or a
change moves the amount. Each withdrawal date takes its amount from the newest
notice issued before it. A policy that never appears on a notice (the home) is
shown as paid through the **mortgage escrow**.

## Checks
- each withdrawal = policy amounts + installment fee (the first/down payment carries none)
- auto: per-vehicle premiums add up to the total
- home: standard + optional = total

## Outputs (`hanoverDerive.ts`)
- Adopts an existing Vault entry titled "Hanover Insurance" (Mike's own) instead of making a second one; auto note "Premiums & Payments" (Premiums, Payment Schedule, Premium Changes, Vehicles Insured); links My Hanover + Finance Dashboard.
- Bills & Due Dates: each withdrawal is a cycle (due the 15th, Auto-Pay from the notice text).
- Flags: unreadable/duplicate, failed checks, `price_up:<line>:<termStart>` (renewal ≥10% above where the last term ended), `missing_after:<termEnd>` (term ended 21+ days ago, no new declarations), `schedule_end:` (info), payer.
- **Renewal reminder:** task "Review Hanover Renewal (…) — Renews <date>" due `RENEWAL_LEAD_DAYS` (30) before the term ends, TaskMeta `{action:'insurance-renewal', folderId}` → "Open Insurance →". One per term end (folder meta `renewalTask`); Mike closing/deleting it is final; checked off automatically once the new term is in effect.

## Report card (2026-10-16)
17/17 PDFs read in local workerd (6 billing notices, 6 auto, 1 home, 4 umbrella declarations incl. three full policy packets of 26–96 pages); 54/54 checks pass. node:sqlite with the real app routes: 26/26.
