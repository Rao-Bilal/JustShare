from fastapi import APIRouter, HTTPException, status
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.db.session import get_engine

router = APIRouter(tags=["system"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def readiness() -> dict[str, str]:
    settings = get_settings()
    try:
        async with get_engine().connect() as connection:
            await connection.execute(text("SELECT 1"))
        redis = Redis.from_url(settings.redis_url)
        try:
            await redis.ping()
        finally:
            await redis.aclose()
    except (ModuleNotFoundError, SQLAlchemyError, OSError, ConnectionError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Dependencies are unavailable.",
        ) from exc
    return {"status": "ready"}
