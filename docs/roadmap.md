# Delivery roadmap

1. **Phase 0 — foundation (current):** bootable web and control-plane skeleton, Compose, migrations, tests, CI, and security documentation.
2. **Phase 1 — web MVP:** account/device identity, pairing, signaling, WebRTC browser flow, explicit approval and basic progress.
3. **Phase 2 — reliable engine:** chunking, resume, integrity, retries and state-machine recovery.
4. **Phase 3 — security hardening:** adversarial tests, rate limiting, abuse controls and dependency/container scans.
5. **Phase 4 — remote routing:** STUN/TURN, connectivity diagnostics and relay fallback.
6. **Phase 5 — advanced web:** drops, links, trusted devices, history, clipboard and notifications.
7. **Phase 6 — Android:** Kotlin/Jetpack Compose client using the same protocol.
8. **Phase 7 — Windows:** C#/.NET/WinUI client using the same protocol.
9. **Phase 8 — production:** TLS, backup, observability, quotas, rollout and rollback procedures.

Each phase requires passing relevant tests, updated documentation and an explicit completion report before the next phase starts.

