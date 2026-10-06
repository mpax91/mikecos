# Statement templates — how every folder plugs in

One template per Drive folder, on the shared engine in `worker/src/statements/`.
Each folder's doc here (`<folder>.md`) records field locations, layout eras,
checks and a report card.

## The Vault note standard (every account follows this)

Each live folder owns one Vault entry (title = the account nickname, e.g.
"NY 529 · Chase"). Statements writes into the entry's own sections — never
everything into Quick Facts:

| Vault section | What goes there | Rule of thumb |
|---|---|---|
| **Quick Facts** | Only what's needed at a glance or in a pinch — about 4–6: account ••last digits, the headline balance (label carries the as-of date), the payment/deposit that matters, a time-sensitive item only while it applies (e.g. "2026 Top-Up"), the institution's phone. | Would Mike need it standing at a counter or on the phone? |
| **Links** | Real Link children, never URL facts: institution website, Finance dashboard, latest statement (title carries the date), Drive folder. | Anything you'd click. |
| **Notes** | One managed note, "Account Details · Auto-Updated": an italic "updated automatically" line, then sections as tables (Account, Balances as of…, the account's yearly/deadline section, Statements table with View links, Change History) and a link to the dashboard. | Everything else worth reading but not needed at a glance. |
| Attachments / Passwords | Untouched — Mike's. Statements stay in Drive. | |

Rules:
- Managed facts carry a `managed_key` (`<template>:` prefix) and sit first,
  in a fixed order. Mike's own facts (no key) are never edited or moved
  relative to each other.
- Managed note/link ids live in `statement_folders.meta_json.vault`. If Mike
  deletes one it stays deleted (not re-created).
- Values always follow the LATEST statement; backfills never roll back.
- Notes are built with `worker/src/statements/vaultDoc.ts` (TipTap JSON:
  heading/para/kv/table/bullets/link) — validate new shapes against the
  editor schema (StarterKit + Table + Link).

## Tax Packet ("Tax Packet · <year>")
Each template contributes a section via `syncTaxPacketSection`
(`taxPacket.ts`): headline totals → Quick Facts, tax documents → Links,
details + an "Expected Documents" checklist → the auto "Tax Items" note.

## Adding a folder
1. Pull every PDF in the folder; find layout eras.
2. `templates/<id>.ts` parser + checks; add to `TEMPLATES`.
3. Test the parser against ALL PDFs **in workerd** (not just Node).
4. `<id>Derive.ts`: flags, reminders, Vault entry per the standard above,
   Tax Packet section.
5. Report card in `<folder>.md`; Mike clicks **Go Live** in Settings → Statements.
