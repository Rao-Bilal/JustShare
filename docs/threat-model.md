# Threat model

## Assets

Protected assets include account credentials, device private keys, pairing secrets, authorization decisions, transfer metadata, file bytes, local download locations and service availability.

## Adversaries

We consider a malicious unauthenticated internet client, a malicious authenticated client, a compromised/hostile LAN peer, a network observer without TLS termination control, and an attacker attempting to exhaust shared service resources.

## Security invariants

- The server authorizes each protected resource operation and fails closed.
- A pairing code or QR payload is temporary, random, scoped, rate-limited and invalidated as designed.
- Private keys and file contents are never collected by the control plane by default.
- Received names and paths never select arbitrary filesystem locations.
- Completion is reported only after cryptographic integrity verification.
- Logs and API errors never disclose secrets or internal diagnostics.

Concrete mitigations and test cases are maintained in [security.md](security.md). New capabilities must amend this model before implementation.

