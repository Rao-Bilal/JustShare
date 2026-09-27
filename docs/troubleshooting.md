# Troubleshooting

- If Compose cannot start, ensure `.env` exists and `POSTGRES_PASSWORD` is set.
- If readiness returns 503, inspect `docker compose logs postgres redis backend` and wait for health checks.
- If port 5173, 8000, 5432, or 6379 is occupied, change the corresponding host port in `.env`.
- If the web build fails, confirm Node.js 22+ and delete only `web/node_modules` before reinstalling dependencies.

