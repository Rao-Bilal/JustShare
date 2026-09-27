# JustShare

JustShare is a privacy-first, cross-platform file transfer platform. The backend is a control plane for identity, pairing, authorization, signaling and metadata; file bytes are designed to travel directly between devices whenever possible.

## Phase 0 status

This repository currently contains the engineering foundation only. It does not implement authentication, pairing, WebRTC signaling, or file transfers.

## Quick start

1. Copy `.env.example` to `.env` and replace the development database password.
2. Run `docker compose up --build`.
3. Open `http://localhost:5173`; API health is at `http://localhost:8000/api/v1/health`.

For local non-container development and verification, see [docs/development.md](docs/development.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Data model plan](docs/data-model.md)
- [Security and threat model](docs/security.md)
- [API conventions](docs/api.md)
- [Future transfer protocol](docs/transfer-protocol.md)
- [Deployment](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Roadmap](docs/roadmap.md)
