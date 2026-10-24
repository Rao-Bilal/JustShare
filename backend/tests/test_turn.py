import httpx
import pytest
from httpx import ASGITransport, AsyncClient, Response

from app.core.config import get_settings
from app.core.security import create_device_token
from app.main import app


@pytest.fixture
def auth_headers():
    settings = get_settings()
    token = create_device_token("dev-test-123", settings.jwt_secret)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_turn_credentials_requires_auth():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/turn/credentials")
        assert response.status_code == 401


@pytest.mark.asyncio
async def test_turn_credentials_unconfigured(auth_headers, monkeypatch):
    monkeypatch.setattr(get_settings(), "cloudflare_turn_key_id", None)
    monkeypatch.setattr(get_settings(), "cloudflare_turn_api_token", None)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/turn/credentials", headers=auth_headers)
        assert response.status_code == 503
        assert "not configured" in response.json()["detail"]


@pytest.mark.asyncio
async def test_turn_credentials_success(auth_headers, monkeypatch):
    monkeypatch.setattr(get_settings(), "cloudflare_turn_key_id", "dummy-key-id")
    monkeypatch.setattr(get_settings(), "cloudflare_turn_api_token", "dummy-token")

    mock_ice_servers = [
        {"urls": ["turn:turn.cloudflare.com:3478?transport=udp"], "username": "user1", "credential": "secretpassword"},
        {"urls": ["turns:turn.cloudflare.com:5349?transport=tcp"], "username": "user1", "credential": "secretpassword"},
    ]

    real_post = httpx.AsyncClient.post

    async def mock_post(self, url, *args, **kwargs):
        if "rtc.live.cloudflare.com" in str(url):
            return Response(200, json={"iceServers": mock_ice_servers})
        return await real_post(self, url, *args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient.post", mock_post)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/turn/credentials", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        assert "iceServers" in data
        assert data["iceServers"] == mock_ice_servers
        # Assert permanent token is never exposed
        assert "dummy-token" not in str(data)


@pytest.mark.asyncio
async def test_turn_credentials_cloudflare_error(auth_headers, monkeypatch):
    monkeypatch.setattr(get_settings(), "cloudflare_turn_key_id", "dummy-key-id")
    monkeypatch.setattr(get_settings(), "cloudflare_turn_api_token", "dummy-token")

    real_post = httpx.AsyncClient.post

    async def mock_post(self, url, *args, **kwargs):
        if "rtc.live.cloudflare.com" in str(url):
            return Response(500, json={"error": "internal"})
        return await real_post(self, url, *args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient.post", mock_post)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/turn/credentials", headers=auth_headers)
        assert response.status_code == 502
        assert response.json()["detail"] == "TURN provider returned an error"
