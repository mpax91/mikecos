# Statement templates — how every folder plugs in

One template per Drive folder, on the shared engine in `worker/src/statements/`.
Each folder's doc here (`<folder>.md`) records field locations, layout eras,
checks and a report card.

## The Vault entry standard (every account follows this)

Each live folder owns one Vault entry (created with the account nickname,
e.g. "NY 529 · Chase" — Mike can rename it; Statements tracks it by id).
**Mike's edits always win.**

| Vault section | What Statements does | Rule of thumb |
|---|---|---|
| **Quick Facts** | Mike's. Statements seeds 2–4 **evergreen** facts once, when it creates the entry (account ••last digits, beneficiary/owner if relevant, institution phone) as ordinary facts — then never adds, edits, reorders or removes a Quick Fact. Nothing that changes (balances, AIP, gaps, as-of dates) ever goes here. | Won't change, needed in a pinch. |
| **Links** | Created once as real Link children: institution website, Finance dashboard, Drive folder (no per-statement links — the Drive folder covers them). Never touched again; Mike can edit, reorder, delete — deletions stick. Links show only their label (no URL subtext, no tags). | Anything you'd click. |
| **Notes** | One note ("Account Details" — Mike may rename it). Seeded with an evergreen Account table plus **owned sections** (matched by their level-2 heading: e.g. "Balances as of…", "2026 NY Deduction", "Statements", "Change History"). Nightly, only the owned sections' bodies are replaced; everything else in the note is Mike's and untouched. An owned section Mike deletes stays deleted. | Everything that changes or is detail. |
| Attachments / Passwords | Untouched — Mike's. Statements stay in Drive. | |

Mechanics: `seedFacts`, `syncAutoNote` (sections + `written` keys so a
deletion is respected; owned blocks carry `autoUpdated` → tinted with an
"Auto-Updates" tag in the editor), `syncManagedLinks` (`live` flag, used
only by Tax Packet document links) in `engine.ts`;
ids in `statement_folders.meta_json.vault`. Values follow the LATEST
statement; backfills never roll back. Build note content with
`vaultDoc.ts` and validate new node shapes against the editor schema.

## Payment Quick Facts (every bill / card account — Mike, 2026-10-07)

The one exception to "Quick Facts are Mike's": up to six auto-updating
facts, written only where they apply and tagged **Auto-Updates** —
**Due Date · Auto-Pay · Paid With · Latest Bill · Average Bill (12 Mo) ·
Average Bill (All-Time)**. They are `vault_facts` rows with
`managed_key = 'pay:*'` (so they appear in Vault search and Rollups).
Editing one makes it Mike's own fact; deleting one keeps it deleted
(`vault_fact_releases`). Code: `worker/src/accountPayers.ts`.

- **Templates:** a template with bills/statement balances builds a
  `BillingFacts` snapshot with `billingFromBills(...)` (date, amount
  charged, total due / statement balance, due date, autopay as printed)
  and stores it as `meta.billing` in the folder's `meta_json`; merge
  `payerFlags(...)` into its flag list. `engine.derive` then calls
  `syncPaymentFacts` for the folder's Vault entry. Averages use what each
  bill charged; Latest Bill uses the total due / statement balance.
- **Paid With** comes from `account_payers` (one row per Vault entry:
  `autopay` | `on_file`, a Wallet payment card or free text for a bank
  account, optional due day). Set from the Vault entry (tap Paid With /
  "＋ Payment Method") or from Wallet → card → **Pays For → Add Account**.
- **Due Date is a day of the month** ("14th"), never a full date (Mike,
  2026-10-08): the day of the latest bill's due date, or the payer's due
  day when no statement prints one. The exact date of the current bill
  belongs in the auto note's current-bill section, not in Quick Facts.
- Auto-Pay: the latest statement wins when it says; otherwise the payer
  mode. Flags: autopay with no card set, statement vs. Wallet mismatch,
  paying card inactive or deleted from Wallet.

### Card Quick Facts (every credit card account — Mike, 2026-10-08)

A second set of auto-updating facts for card accounts, same rules as the
payment facts (`managed_key 'card:*'`, Auto-Updates tag, Mike's edit or
delete wins). Code: `worker/src/cardFacts.ts`.

| Fact | Source |
|---|---|
| Card Type | Wallet card's network when set (e.g. "Visa Signature"), else the template's `account.network` |
| Credit Limit · Purchase APR · Cash Advance Limit | latest statement |
| Expires | Wallet card expiry (MM/YYYY) — statements don't print it |
| Rewards | what the card earns **today**: the MikeOS Rewards card (fixed bonuses + rotating bonuses whose dates cover today + base rate), else the earn categories on the latest statement |
| Number & CVV | "Saved in Wallet" when Wallet holds them — the values stay encrypted in Wallet (reveal on tap), never in a plain-text fact |

Wallet and Rewards cards are matched by **last 4**. A card template's
derive stores a `CardFacts` snapshot as `meta.card`; `engine.derive` calls
`syncCardFacts`. Wallet card create/edit/delete and any Rewards card / bonus
change re-sync right away.

## Tax Packet ("Tax Packet · <year>")
Each template contributes a section via `syncTaxPacketSection`
(`taxPacket.ts`): tax documents → Links; its section (heading = account
nickname) + the shared "Expected Documents" checklist are owned sections
of the "Tax Items · <year>" note. No Quick Facts are written.

## Adding a folder
1. Pull every PDF in the folder; find layout eras.
2. `templates/<id>.ts` parser + checks; add to `TEMPLATES` with
   `account.kind` — `'balance'` (counts toward Finance totals) or `'bill'`
   (utilities/services: Finance shows the latest bill + monthly cost) — and
   `isStatementFile(name)` if the folder also holds non-statements
   (they're recorded as Skipped, never flagged).
3. Test the parser against ALL PDFs **in workerd** (not just Node).
4. `<id>Derive.ts`: flags, reminders, Vault entry per the standard above,
   Tax Packet section.
5. Dashboard: `/api/statements/folders/:id/dashboard` switches on the
   template and returns a `kind`; `FinanceAccountPage` renders the matching
   component (`Ny529Dashboard`, `AdtDashboard`, `AllyDashboard`, `AmazonDashboard`) on the
   shared `fin-dash__*` card CSS.
6. Report card in `<folder>.md`; Mike clicks **Go Live** in Settings → Statements.

Live templates: `ny529` (529.md), `adt` (adt.md), `ally` (ally.md), `amazon` (amazon.md — first credit card; account kind `card`).

**Multi-account statements** (Ally): `ParsedTransaction.account` = last 4
digits (stored in `statement_transactions.account`, migration 0093);
key accounts by last 4, never by product name.
