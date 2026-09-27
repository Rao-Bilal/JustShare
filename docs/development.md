# Development

## Prerequisites

Docker Desktop (Compose v2), Python 3.12+, and Node.js 22+ are supported. Copy `.env.example` to `.env` before starting Compose.

## Containers

Run `docker compose up --build`. Check `docker compose ps`, then use `curl http://localhost:8000/api/v1/health` and `curl http://localhost:8000/api/v1/ready`.

## Local processes

Start dependencies with `docker compose up postgres redis -d`. In `backend`, create a virtual environment, install `pip install -e ".[dev]"`, then run `uvicorn app.main:app --reload`. In `web`, run `npm install` then `npm run dev`.

## Quality checks

`cd backend; ruff check .; pytest` and `cd web; npm run lint; npm run test; npm run build`.

