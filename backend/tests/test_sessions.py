import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_session(async_client: AsyncClient):
    dev_res = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    token = dev_res.json()["token"]
    
    res = await async_client.post(
        "/api/v1/sessions", 
        json={}, 
        headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 201
    data = res.json()
    assert "session_id" in data
    assert len(data["pairing_code"]) == 6
    assert data["state"] == "WAITING_FOR_PEER"

@pytest.mark.asyncio
async def test_create_session_unauthorized(async_client: AsyncClient):
    res = await async_client.post("/api/v1/sessions", json={})
    assert res.status_code == 401

@pytest.mark.asyncio
async def test_join_session(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok1 = dev1.json()["token"]
    
    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok1}"})
    pairing_code = sess_res.json()["pairing_code"]
    
    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Receiver"})
    tok2 = dev2.json()["token"]
    
    join_res = await async_client.post(
        "/api/v1/sessions/join",
        json={"pairing_code": pairing_code},
        headers={"Authorization": f"Bearer {tok2}"}
    )
    assert join_res.status_code == 200
    assert join_res.json()["state"] == "PAIRED"
    assert join_res.json()["sender"]["display_name"] == "Sender"

@pytest.mark.asyncio
async def test_join_invalid_code(async_client: AsyncClient):
    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Receiver"})
    tok2 = dev2.json()["token"]
    
    join_res = await async_client.post(
        "/api/v1/sessions/join",
        json={"pairing_code": "000000"},
        headers={"Authorization": f"Bearer {tok2}"}
    )
    assert join_res.status_code == 404

@pytest.mark.asyncio
async def test_session_state_update(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok1 = dev1.json()["token"]
    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok1}"})
    sess_id = sess_res.json()["session_id"]
    
    upd_res = await async_client.patch(
        f"/api/v1/sessions/{sess_id}/state",
        json={"state": "CANCELLED"},
        headers={"Authorization": f"Bearer {tok1}"}
    )
    assert upd_res.status_code == 200
    assert upd_res.json()["state"] == "CANCELLED"

@pytest.mark.asyncio
async def test_invalid_state_transition(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok1 = dev1.json()["token"]
    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok1}"})
    sess_id = sess_res.json()["session_id"]
    
    upd_res = await async_client.patch(
        f"/api/v1/sessions/{sess_id}/state",
        json={"state": "COMPLETED"},
        headers={"Authorization": f"Bearer {tok1}"}
    )
    assert upd_res.status_code == 400

@pytest.mark.asyncio
async def test_session_access_unauthorized(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok1 = dev1.json()["token"]
    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok1}"})
    sess_id = sess_res.json()["session_id"]
    
    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Other"})
    tok2 = dev2.json()["token"]
    
    get_res = await async_client.get(f"/api/v1/sessions/{sess_id}", headers={"Authorization": f"Bearer {tok2}"})
    assert get_res.status_code == 403

@pytest.mark.asyncio
async def test_idempotent_state_update(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok1 = dev1.json()["token"]
    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok1}"})
    sess_id = sess_res.json()["session_id"]
    
    # State is WAITING_FOR_PEER
    upd1 = await async_client.patch(
        f"/api/v1/sessions/{sess_id}/state",
        json={"state": "WAITING_FOR_PEER"},
        headers={"Authorization": f"Bearer {tok1}"}
    )
    assert upd1.status_code == 200
    assert upd1.json()["state"] == "WAITING_FOR_PEER"


@pytest.mark.asyncio
async def test_get_session_valid(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok1 = dev1.json()["token"]
    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok1}"})
    sess_id = sess_res.json()["session_id"]
    pairing_code = sess_res.json()["pairing_code"]

    # Before receiver joins
    res_sender_only = await async_client.get(f"/api/v1/sessions/{sess_id}", headers={"Authorization": f"Bearer {tok1}"})
    assert res_sender_only.status_code == 200
    data_sender_only = res_sender_only.json()
    assert data_sender_only["sender"]["display_name"] == "Sender"
    assert data_sender_only["receiver"] is None

    # Receiver joins
    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Receiver"})
    tok2 = dev2.json()["token"]
    await async_client.post("/api/v1/sessions/join", json={"pairing_code": pairing_code}, headers={"Authorization": f"Bearer {tok2}"})

    # After receiver joins, both sender and receiver can retrieve session details
    for tok in [tok1, tok2]:
        res_paired = await async_client.get(f"/api/v1/sessions/{sess_id}", headers={"Authorization": f"Bearer {tok}"})
        assert res_paired.status_code == 200
        data_paired = res_paired.json()
        assert data_paired["sender"]["display_name"] == "Sender"
        assert data_paired["receiver"]["display_name"] == "Receiver"


@pytest.mark.asyncio
async def test_create_session_with_nonexistent_device(async_client: AsyncClient):
    import uuid

    from app.core.config import get_settings
    from app.core.security import create_device_token

    settings = get_settings()
    fake_device_id = str(uuid.uuid4())
    fake_token = create_device_token(fake_device_id, settings.jwt_secret)

    res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {fake_token}"})
    assert res.status_code == 404
    assert res.json()["detail"] == "Device not found"


@pytest.mark.asyncio
async def test_get_session_missing_sender_device_returns_404(async_client: AsyncClient):
    import uuid

    from sqlalchemy import select

    from app.db.session import get_db_session
    from app.main import app as fastapi_app
    from app.models.device import Device

    # Create device and session normally
    dev_res = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    token = dev_res.json()["token"]
    device_id = dev_res.json()["device_id"]

    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {token}"})
    sess_id = sess_res.json()["session_id"]

    # Delete sender device record to simulate orphaned/stale session
    override = fastapi_app.dependency_overrides[get_db_session]
    async for s in override():
        dev_obj = (await s.execute(select(Device).where(Device.id == uuid.UUID(device_id)))).scalars().first()
        await s.delete(dev_obj)
        await s.commit()

    # Must return 404 cleanly instead of raising AttributeError (500)
    res = await async_client.get(f"/api/v1/sessions/{sess_id}", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 404
    assert res.json()["detail"] == "Sender device not found"


@pytest.mark.asyncio
async def test_join_session_missing_sender_device_returns_404(async_client: AsyncClient):
    import uuid

    from sqlalchemy import select

    from app.db.session import get_db_session
    from app.main import app as fastapi_app
    from app.models.device import Device

    dev_res = await async_client.post("/api/v1/devices", json={"display_name": "Sender"})
    tok_sender = dev_res.json()["token"]
    device_id = dev_res.json()["device_id"]

    sess_res = await async_client.post("/api/v1/sessions", json={}, headers={"Authorization": f"Bearer {tok_sender}"})
    pairing_code = sess_res.json()["pairing_code"]

    override = fastapi_app.dependency_overrides[get_db_session]
    async for s in override():
        dev_obj = (await s.execute(select(Device).where(Device.id == uuid.UUID(device_id)))).scalars().first()
        await s.delete(dev_obj)
        await s.commit()

    dev_receiver = await async_client.post("/api/v1/devices", json={"display_name": "Receiver"})
    tok_receiver = dev_receiver.json()["token"]

    res = await async_client.post(
        "/api/v1/sessions/join",
        json={"pairing_code": pairing_code},
        headers={"Authorization": f"Bearer {tok_receiver}"}
    )
    assert res.status_code == 404
    assert res.json()["detail"] == "Sender device not found"



