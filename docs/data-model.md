# Data model plan

PostgreSQL is the authoritative store. All primary identifiers are UUIDs; foreign keys and ownership checks enforce resource boundaries. Redis is intentionally excluded from this model because it holds only expiring operational state.

## Phase 0

`devices`: `id`, display name, creation time. It is only a migration-proving placeholder and is not a trusted identity.

## Planned Phase 1 and beyond

| Entity | Purpose | Sensitive constraints |
| --- | --- | --- |
| users | Account identity | Password hashes only; no plaintext credentials |
| device_identities | Public keys, device binding, revocation | Private keys never enter the database |
| pairing_sessions | Durable audit/minimal pairing metadata | Secrets/codes live short-term in Redis and expire |
| transfers | Owner, sender, receiver, state, route, byte totals | Every query scoped by ownership/participation |
| transfer_files | Normalized relative path, size, SHA-256 | No arbitrary server path or file contents |
| trusted_devices | Explicit trust relationships | Revocation checked during authorization |
| transfer_events | Minimal state audit trail | Retention policy and redaction required |

