# Payment Readiness Scaffold Checkpoint - 2026-05-31

## Summary

This checkpoint documents the first production payment scaffold for Tzurah/Loqii.
It is intentionally disabled:

- provider: `none`
- configured: `false`
- live_mode: `false`
- checkout: disabled
- webhook fulfillment: disabled

No real payment provider is active from this checkpoint.

## Systems Added

- Provider-agnostic payment status model.
- Disabled checkout endpoint scaffold.
- Disabled webhook endpoint scaffold.
- Payment readiness admin panel.
- Payment lifecycle and idempotency documentation.
- Credit pack purchase launch gates.
- Critical alert hooks for real payment/webhook attempts while disabled.

## Non-Goals

This checkpoint does not enable live payments, alter credit deduction math, alter protected billing, alter reconciliation, alter Decart routing, or modify realtime session lifecycle.

## Runtime Invariants

- Real payments remain disabled until explicitly launched.
- Checkout must fail closed when provider is `none`.
- Webhooks must fail closed when provider is not configured.
- Fulfillment must require verified webhooks, idempotency, and ledger writes.
- Credit grants from purchases must be server-owned.
- Usage billing and top-up purchase fulfillment are separate systems.
- Mock payments remain dev/test only.
- No provider secret may appear in public config, app config, logs, docs, or renderer code.

## Launch Gates

Before enabling real payments:

1. Choose provider and document contract.
2. Add provider secrets only in production environment storage.
3. Verify webhook signatures before parsing fulfillment.
4. Add `payment_purchases`, `payment_events`, and `credit_ledger` storage.
5. Enforce idempotency on checkout creation and webhook fulfillment.
6. Run reconciliation against provider events and credit ledger.
7. Prove rollback/refund behavior.
8. Enable admin flag only for super admin.
9. Enable user checkout behind feature flags.

## Rollback

Rollback is the default state: set provider to `none`, configured to `false`, live mode to `false`, and payment flags off.

