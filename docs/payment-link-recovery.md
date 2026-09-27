# Razorpay admission link reconciliation and recovery

This describes the payment-link refinement for PR #13. It is an operator runbook, not a record of production actions. Development verification uses mocked provider responses and an injected PGlite database.

## Verified provider contract

The following official public Razorpay documentation was read on 2026-09-27:

- [Create a standard Payment Link](https://razorpay.com/docs/api/payments/payment-links/create-standard/): the response contains the provider `id`; `accept_partial: false` disables partial payments. `notes` belongs to the link. This documentation does **not** establish that those notes propagate to a fetched Payment.
- [Fetch all standard Payment Links](https://razorpay.com/docs/api/payments/payment-links/fetch-all-standard/): the documented `payment_id` query parameter filters by the payment associated with a link.
- [Fetch a standard Payment Link by ID](https://razorpay.com/docs/api/payments/payment-links/fetch-id-standard/): the canonical link has amount, currency, amount paid and captured `payments[]` entries containing `payment_id`, amount and status.
- [Payment Link entity](https://razorpay.com/docs/api/payments/payment-links/entity/): only captured payments appear in `payments[]`. The parameter documentation includes `plink_id`, but the fetch-by-ID example omits it. We validate it if supplied and do not require it.

The implementation uses the documented standard Payment Links APIs, with these conservative requirements for a **new credit**:

1. Fetch `/v1/payments/{payment_id}` using the connected merchant credentials. Require a captured payment, status `captured` or `refunded`, positive integer paise and INR. Check the signed capture amount, or the canonical processed refund ID/payment/amount for a refund event.
2. Fetch `/v1/payment_links?payment_id={payment_id}`. Require exactly one returned link. This response is discovery only; its notes and payments array are not attribution evidence.
3. Fetch `/v1/payment_links/{plink_id}`. Require the requested ID, `accept_partial: false`, status `paid`, exact payment amount/currency, exact `amount_paid`, and exactly one captured payment entry matching payment ID and full amount. Validate the entry's `plink_id` when present.
4. Under the tenant organization lock, load the matching durable issued-link record and validate its tenant, provider link ID, amount, INR, connection ID and key-ID fingerprint. Use its lead ID for attribution. Provider and webhook notes are ignored.
5. Credit the payment and set `creditedPaymentId` on the issued-link record in the **same transaction**. A different payment cannot consume that link, even concurrently. Replays of the same payment remain idempotent. Refunds never clear the claim. A claim whose ledger record is missing is held for investigation.

New issuance explicitly disables partial payments and provider email/SMS notification. It persists the provider-returned link ID before returning its URL to the caller. There is no distributed transaction with Razorpay: a remote create followed by a local failure can leave an orphan link. It cannot be credited without local issuance evidence. Do not blindly repeat an uncertain create operation.

## Existing records and limits

- Previously credited Razorpay receipts retain their stored lead attribution and can receive refunds with no link lookup or payment notes. Canonical payment ID, captured state, INR and amount must still match; the exact existing receipt is rechecked under the lock. Refund IDs remain idempotent and total refunds cannot exceed that receipt.
- This compatibility path trusts the existing ledger's attribution; it does not retroactively certify historical notes-based credits. Audit questionable old receipts separately, without deleting or rewriting their financial history.
- Old uncredited links with no issued record, or with a version-1 UUID/notes marker, remain pending and eventually exhaust the bounded inbox retries. No automatic conversion, inference from notes, or backfill occurs.
- Unassociated merchant payments also remain held, since notes cannot safely establish that they are irrelevant. Operators should monitor the backlog; this change does not add an ignore/disposition command.
- Partial/multiple-payment links, non-INR payments, ambiguous associations and unexpected provider response shapes are held. A temporary empty discovery response or delayed canonical association is retryable. No fallback to notes exists.
- One issued provider link can credit one full payment. Separately issued links for the same lead are independent; enforcing invoice or installment uniqueness needs a fee/invoice model outside this change.
- Merchant identity is conservatively bound to the connection ID and SHA-256 of the API key ID. Secret-only rotation with the same key ID can recover. Key-ID changes, even within the same real merchant account, require a separately reviewed identity recovery; do not rewrite fingerprints to bypass this guard.
- Provider identifiers and authenticated GET responses are assumed to identify stable merchant-owned resources. Live merchant API compatibility has not been exercised. If actual responses differ from the documented shapes, preserve the hold and review sanitized evidence before changing validation.

## Safe recovery of an older uncredited link

The existing replay command does **not** register legacy links. Registration requires a separately reviewed maintenance transaction with the evidence and invariants below. Do not make it a generic automatic migration.

1. **Identify the held event.** In an authorized operator environment, run:

   ```text
   npm run payments:inspect -- --workspace <workspace-uuid>
   ```

   This is read-only and lists at most 50 pending/failed events. Select the exact `razorpay_admission:<workspace-uuid>:<body-sha256>` receipt; inspect its tenant-scoped payload through approved database tooling for the signed payment/refund reference, original connection ID and key fingerprint. Check that no active processing lease is being overridden. Do not put credentials or raw customer/card responses in tickets or terminal logs.

2. **Establish independent issuance evidence.** Obtain the original provider creation response/retained issued-link ID and the institute's contemporaneous authorization for that lead and exact fee amount. A stored original link ID associated with the issued URL, supported by the original authorization record, is acceptable. Payment or link notes, a newly edited provider reference, a signed webhook, or a matching amount alone are insufficient. A version-1 UUID marker proves no canonical link association by itself. If the provider link ID and local authorization cannot be independently established, **stop** and leave the event held for finance investigation; this release offers no automatic safe recovery.

3. **Read and reconcile provider evidence.** Using the same merchant context, perform only the three GETs in the contract above, and `/v1/refunds/{refund_id}` when applicable. Compare their IDs to the independent issuance evidence. Verify exactly one full captured payment, INR, all amounts, disabled partial payments and the correct merchant. Establish that the original locally authorized lead still exists in this tenant. Check the ledger by payment ID and payment reference, existing refunds, issued-link claims, and other held receipts. If a captured receipt already exists, use the compatibility replay path without registering a new link. Conflicting credits or historical attribution require a separate financial correction review.

4. **Register only the verified missing issuance record.** A reviewed maintenance transaction must set the tenant context, lock its organization row (the same order as reconciliation), and recheck the live non-demo institute, current connected Razorpay credentials, original inbox merchant binding, lead and ledger. Require that the exact target record is absent and that no conflicting claim/credit exists. Use a plain insert that fails on conflict; never upsert, overwrite an existing claim, clear `creditedPaymentId`, modify an inbox reference/fingerprint, or create revenue manually to bypass reconciliation. Preserve the version-1 row if present.

   The exact new row contract in `event_receipts` is:

   ```text
   id              = razorpay_link:<workspace-uuid>:<verified-plink-id>
   organization_id = <workspace-uuid>
   provider        = razorpay_link
   received_at     = <recovery registration time, ISO UTC>
   processed_at    = <same recovery registration time, ISO UTC>
   error           = null
   payload         = {
     "version": 2,
     "providerLinkId": "<verified-plink-id>",
     "leadId": "<independently-authorized-lead-uuid>",
     "amountPaise": <exact-positive-integer>,
     "currency": "INR",
     "connectionId": "<original-and-current-connection-uuid>",
     "keyFingerprint": "<SHA-256 lowercase hex of original-and-current API key ID>"
   }
   ```

   Omit `creditedPaymentId` for this genuinely uncredited link. `processed_at` here means issuance registration completed, not that a payment webhook has completed. Record the actor, review approval, independent evidence location, old marker ID if any, new row ID and before/after checks in the restricted operational audit record. The new row holds no API secret or customer/card data. No registration CLI or production SQL execution is included in this change.

5. **Replay only the selected held receipt.** After reviewed registration, use:

   ```text
   npm run payments:inspect -- --workspace <workspace-uuid> --receipt <exact-receipt-id> --apply
   ```

   This performs provider GETs and local financial writes. It issues no provider charge, refund, link, email or SMS. It will still refuse merchant mismatch or an active lease. Confirm one Razorpay ledger entry with the authorized lead, amount and payment ID; the same `creditedPaymentId` on the issued record; the expected processed refund(s) within the capture total; and completion of the inbox receipt. Replay other known held events for that payment individually if needed. If validation fails, retain the hold and investigate; do not weaken the association or reset the link claim.
