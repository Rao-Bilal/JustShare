import jwt
import pytest
from httpx import AsyncClient

from app.core.config import get_settings


@pytest.mark.asyncio
async def test_create_device(async_client: AsyncClient):
    response = await async_client.post("/api/v1/devices", json={"display_name": "Test Device"})
    assert response.status_code == 201
    data = response.json()
    assert "device_id" in data
    assert data["display_name"] == "Test Device"
    assert "token" in data

@pytest.mark.asyncio
async def test_create_device_empty_name(async_client: AsyncClient):
    response = await async_client.post("/api/v1/devices", json={"display_name": ""})
    assert response.status_code == 422

@pytest.mark.asyncio
async def test_create_device_long_name(async_client: AsyncClient):
    response = await async_client.post("/api/v1/devices", json={"display_name": "A" * 129})
    assert response.status_code == 422

@pytest.mark.asyncio
async def test_device_token_is_valid_jwt(async_client: AsyncClient):
    response = await async_client.post("/api/v1/devices", json={"display_name": "Test Token Device"})
    data = response.json()
    token = data["token"]
    
    settings = get_settings()
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    assert payload["device_id"] == data["device_id"]
