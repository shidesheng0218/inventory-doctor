# Pilot and live validation checklist

These are planned acceptance tasks, NOT evidence of completed external trials.
Do not use exposed or old development-store secrets; rotate them before testing.

## Three independent pilot sessions

Recruit voluntarily where community rules allow product feedback requests; disclose that you are the author. Do not mass-message, request votes, or imply Shopify endorsement.

Invitation draft:

> I maintain Inventory Doctor, an open-source, local inventory comparison tool. I'm looking for three developers or operations users to try it with their own exports. It does not synchronize or change store inventory. Could you try the bundled demo, then a redacted export, and tell me which findings are useful or misleading? No credentials or customer data needed, and no obligation to buy anything.

| Participant | Task | Success evidence |
| --- | --- | --- |
| Single-store operator | Run demo, then compare two compatible exports | Completes without author operating their computer; can distinguish observed differences from inferred risk |
| Multi-location operator | Check SKU/location/state alignment and inspect proposals | Identifies ambiguous mappings; does not mistake proposals for import instructions |
| Developer/agency | Configure MCP; save/check history; preview retention | Can trace evidence and handle invalid input; understands read/write boundaries |

For each session record (with permission): date, role, completion time, help needed, a useful finding, a false positive, a missing workflow, whether they actually run it again. Do not collect real SKU exports by default. Ask for a minimal synthetic reproduction retaining only column names and the error shape; remove emails, addresses, customer/order IDs, tokens, private URLs and commercial quantities.

Completion criteria: three *real* sessions with feedback, not three mock runs. Stars and registry downloads are not substitutes. Before building hosted services, look for repeat usage and an explicit request for managed scheduling.

## Shopify read-only acceptance

- Use authorized development stores and newly rotated credentials.
- Check token exchange and required read scopes.
- Compare a known SKU across at least two locations with quantities recorded manually.
- Exercise more than 20 locations only if the test account supports them; otherwise state that this path is unit-tested, not live-tested.
- Confirm returned API version, quantities and location identity against the admin UI.
- A saved HTTP fixture tests a known response shape, not future upstream compatibility.

## Import safety gate

Current `--fix-export` emits a **review proposal, not an importable Shopify file**. Never upload it to an inventory importer.

Before implementing a future import generator:
1. Download the actual current inventory template from the test store; preserve required identity and location fields.
2. Create isolated test SKUs with nonzero committed/unavailable quantities and record available and on-hand separately.
3. Define the user-approved reconciliation baseline and intended change; never infer truth solely from input ordering.
4. Verify exact, unique target SKU/location mapping. Block ambiguous, aggregated, missing or negative proposed quantities.
5. Generate a separate candidate import only when state semantics and template requirements are explicit. Available must not be copied into on-hand.
6. Have the owner review and import it manually in the development store.
7. Re-export/read via API and compare every state and unaffected SKU; check outstanding orders are unchanged.
8. Record accepted/rejected columns, expected/actual state changes and recovery steps.

Passing local round-trip tests does not satisfy this gate. Until a real import has been performed and verified, do not market the export as directly importable or as a proven repair.
