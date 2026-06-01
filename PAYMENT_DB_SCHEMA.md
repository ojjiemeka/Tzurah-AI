# Payment Database Schema Plan

This is a schema plan, not an applied migration.

## payment_purchases

- `id uuid primary key`
- `user_id uuid not null`
- `provider text not null`
- `provider_checkout_id text`
- `provider_payment_id text`
- `credit_pack_id text not null`
- `amount_cents integer not null`
- `currency text not null default 'USD'`
- `credits integer not null`
- `status text not null`
- `idempotency_key text not null unique`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

## payment_events

- `id uuid primary key`
- `provider text not null`
- `provider_event_id text not null`
- `event_type text not null`
- `purchase_id uuid`
- `signature_verified boolean not null default false`
- `processed boolean not null default false`
- `processed_at timestamptz`
- `payload_hash text not null`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

Unique index:

- `(provider, provider_event_id)`

## credit_ledger

- `id uuid primary key`
- `user_id uuid not null`
- `source text not null`
- `source_id uuid`
- `credits_delta numeric not null`
- `balance_before numeric`
- `balance_after numeric`
- `idempotency_key text not null unique`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

## Invariants

- One provider event can be processed once.
- One purchase fulfillment can grant credits once.
- Ledger is append-only.
- Profile credit mutation and ledger insert must be atomic.
- Reconciliation must compare provider, purchase, ledger, and profile balance.

