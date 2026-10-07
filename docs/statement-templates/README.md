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
| **Links** | Created once as real Link children: institution website, Finance dashboard, latest statement, Drive folder. Only "live" links (Latest Statement) keep their URL/title current. Mike can rename, reorder, delete — deletions stick. | Anything you'd click. |
| **Notes** | One note ("Account Details" — Mike may rename it). Seeded with an evergreen Account table plus **owned sections** (matched by their level-2 heading: e.g. "Balances as of…", "2026 NY Deduction", "Statements", "Change History"). Nightly, only the owned sections' bodies are replaced; everything else in the note is Mike's and untouched. An owned section Mike deletes stays deleted. | Everything that changes or is detail. |
| Attachments / Passwords | Untouched — Mike's. Statements stay in Drive. | |

Mechanics: `seedFacts`, `syncAutoNote` (sections + `written` keys so a
deletion is respected), `syncManagedLinks` (`live` flag) in `engine.ts`;
ids in `statement_folders.meta_json.vault`. Values follow the LATEST
statement; backfills never roll back. Build note content with
`vaultDoc.ts` and validate new node shapes against the editor schema.

## Tax Packet ("Tax Packet · <year>")
Each template contributes a section via `syncTaxPacketSection`
(`taxPacket.ts`): tax documents → Links; its section (heading = account
nickname) + the shared "Expected Documents" checklist are owned sections
of the "Tax Items · <year>" note. No Quick Facts are written.

## Adding a folder
1. Pull every PDF in the folder; find layout eras.
2. `templates/<id>.ts` parser + checks; add to `TEMPLATES`.
3. Test the parser against ALL PDFs **in workerd** (not just Node).
4. `<id>Derive.ts`: flags, reminders, Vault entry per the standard above,
   Tax Packet section.
5. Report card in `<folder>.md`; Mike clicks **Go Live** in Settings → Statements.
