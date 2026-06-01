# Payment Production Readiness

## Current Status

Payments are scaffolded and disabled.

- provider: `none`
- configured: `false`
- live_mode: `false`
- checkout enabled: `false`
- webhook processing enabled: `false`
- fulfillment enabled: `false`

## Architecture

Payment ownership belongs to the Tzurah backend. Loqii only consumes safe status and asks the backend to start checkout when enabled.

Public/app-safe endpoints:

- `GET /api/payments/config` returns provider/status metadata with no secrets.
- `POST /api/payments/checkout` is authenticated and currently fails closed.
- `GET /api/payments/status/:purchase_id` is authenticated and currently fails closed.
- `POST /api/payments/webhook/:provider` currently fails closed while providers are disabled.

Admin:

- `GET /admin/api/payments/readiness` renders the disabled payment readiness state.

## Feature Flags

All production payment flags default off:

- `enable_payments`
- `enable_payment_checkout`
- `enable_payment_webhooks`
- `enable_payment_admin_tools`
- `enable_credit_pack_purchase`
- `enable_real_payments`

Mock payments are separate and dev/test only.

## Provider Requirements

Before a provider can be enabled:

- Provider secrets must live only in server environment storage.
- Webhook signature verification must pass before fulfillment.
- Checkout creation must use idempotency keys.
- Webhook fulfillment must be idempotent.
- Credit grants must write an immutable ledger event.
- Reconciliation must compare provider event, purchase row, and credit ledger.
- Refund/chargeback flows must be documented.

## Failure Policy

Payment systems fail closed:

- Missing provider config returns `payments_not_configured`.
- Webhook attempts while disabled return a disabled response.
- Legacy Stripe checkout/webhook routes are blocked by the payment scaffold.
- No user receives credits from an unverified payment event.

