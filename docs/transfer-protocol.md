# Transfer protocol (planned)

This document is a design contract, not an implemented protocol. A transfer is created in the control plane, explicitly approved by the receiver, negotiated over authenticated signaling, then routed by `LAN → P2P → TURN → relay` based on actual capability and connectivity.

Each future file record will have a controlled file ID, normalized relative path, declared byte count, SHA-256 and ordered chunks. Chunk messages bind transfer ID, file ID, index and expected size. Receivers validate authorization, bounds and hashes; completion requires whole-file SHA-256 verification. Resume exchanges authenticated receiver-observed chunk state and never trusts unverified client claims.

Transfer states are `CREATED`, `WAITING`, `ACCEPTED`, `CONNECTING`, `TRANSFERRING`, `PAUSED`, `RESUMING`, `COMPLETED`, `FAILED`, `CANCELLED`, and `EXPIRED`.

