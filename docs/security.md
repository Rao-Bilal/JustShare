# Security and threat model

## Trust boundaries

Every client, LAN, WebSocket peer and metadata field is untrusted. Device names, addresses, MIME types, filenames, declared sizes, transfer state and chunk claims are advisory only and require independent validation.

## Primary threats and controls

| Threat | Required control |
| --- | --- |
| Account takeover | Argon2id, short-lived tokens, secure refresh handling, rate limits |
| Pairing brute force/replay | Cryptographic randomness, TTL, attempt limits, one-time invalidation, Redis rate limits |
| IDOR/cross-device access | Resource authorization on every operation, UUIDs, server-side ownership checks |
| Malicious files/paths | Controlled storage identifiers, filename/path normalization, size/chunk bounds, no execution |
| WebSocket abuse | Auth, origin/session checks, limits, timeouts, authorization per message |
| Relay/backend exposure | TLS/WSS, minimal metadata, no default file storage, redacted structured logs |

## Security posture

Production requires TLS termination, explicit CORS, CSP/HSTS/frame policy configured at the proxy, secret injection outside source control, dependency scanning and audit logs without secrets. No custom cryptography will be implemented.

