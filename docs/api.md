# API conventions

All public API routes are versioned under `/api/v1`. Successful resources use JSON objects. Errors use `{ "error": { "code": "MACHINE_CODE", "message": "Safe user message" } }`; internal causes are logged, not returned.

The Phase 0 endpoints are `GET /api/v1/health` (liveness) and `GET /api/v1/ready` (PostgreSQL and Redis readiness). Future route groups are `/auth`, `/devices`, `/pairing`, `/transfers`, `/drops`, and `/links`; WebSockets will be `/ws/v1/signaling` and `/ws/v1/events`.

Every non-public endpoint will validate the authenticated user, device, session and target resource. IDs are UUIDs. Request IDs may be supplied in `X-Request-ID` and are returned in responses.

