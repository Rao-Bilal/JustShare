from fastapi import APIRouter

from app.api.v1.devices import router as devices_router
from app.api.v1.health import router as health_router
from app.api.v1.sessions import router as sessions_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(devices_router, prefix="/devices", tags=["devices"])
api_router.include_router(sessions_router, prefix="/sessions", tags=["sessions"])
# No prefix for signaling here, it'll be included in main.py under /ws/v1/signal
