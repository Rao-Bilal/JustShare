import logging

from fastapi import APIRouter, Response
from sqlalchemy import text

from app.db.session import get_db_session

logger = logging.getLogger(__name__)
router = APIRouter()

@router.get("/health", status_code=200)
async def health():
    return {"status": "ok"}

@router.get("/ready", status_code=200)
async def readiness(response: Response):
    # Check DB
    try:
        async for session in get_db_session():
            await session.execute(text("SELECT 1"))
            break
    except Exception as e:
        logger.error(f"DB health check failed: {e}")
        response.status_code = 503
        return {"status": "error", "message": "Database unavailable"}
        
    return {"status": "ok"}
