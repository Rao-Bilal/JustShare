# Architecture

## Decision

JustShare starts as a modular monolith. FastAPI is the control plane for identity, authorization, pairing, session coordination, signaling and minimal transfer metadata. PostgreSQL is durable state; Redis is only short-lived state, rate-limit counters and future locks. The React web client is the first client.

## Data plane boundary

File bytes must prefer device-to-device routes: local/native direct routes when available, browser WebRTC P2P, TURN relay, then an explicitly designed relay fallback. The control plane does not store or proxy file bytes by default. Routing is a platform-neutral `TransferRouter` concept, not a React or API concern.

## Phase 0 scope

The current service only exposes liveness and dependency readiness endpoints. The `Device` model is a placeholder foundation, not an identity implementation. Authentication, WebSockets, WebRTC, pairing and transfers begin only in Phase 1 after approval.

## Proposed layout

`backend/app/{api,core,db,models,repositories,schemas,services,websocket}` holds isolated backend modules. `web/src/{app,components,pages,features,services,api,websocket,types,utils,security}` will hold client modules. This phase creates only the modules needed for a bootable foundation.

