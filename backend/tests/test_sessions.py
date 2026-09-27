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

