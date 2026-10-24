import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_current_device_id
from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter()

CLOUDFLARE_TURN_URL_TEMPLATE = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"


@router.post("/credentials", response_model=dict[str, Any], status_code=status.HTTP_200_OK)
async def get_turn_credentials(
    device_id: str = Depends(get_current_device_id),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if not settings.cloudflare_turn_key_id or not settings.cloudflare_turn_api_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloudflare TURN service is not configured",
        )

    url = CLOUDFLARE_TURN_URL_TEMPLATE.format(key_id=settings.cloudflare_turn_key_id)
    headers = {
        "Authorization": f"Bearer {settings.cloudflare_turn_api_token}",
        "Content-Type": "application/json",
    }
    payload = {"ttl": 86400}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload, headers=headers)
    except httpx.RequestError as exc:
        logger.error("Failed to connect to Cloudflare TURN API: %s", exc.__class__.__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to contact TURN provider",
        ) from exc

    if response.status_code != 200:
        logger.error("Cloudflare TURN API returned error status: %d", response.status_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TURN provider returned an error",
        )

    data = response.json()
    ice_servers = data.get("iceServers")
    if not ice_servers or not isinstance(ice_servers, list):
        logger.error("Cloudflare TURN API returned invalid response format")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Invalid response format from TURN provider",
        )

    return {"iceServers": ice_servers}
