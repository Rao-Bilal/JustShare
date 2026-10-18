import pytest
from httpx import AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_nearby_websocket_unauthorized():
    from starlette.testclient import TestClient
    client = TestClient(app)
    with client.websocket_connect("/ws/v1/nearby?token=invalid_token") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "error"
        assert msg["payload"]["code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_nearby_announce_and_discovery(async_client: AsyncClient):
    # Register 2 devices
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Device A"})
    tok1 = dev1.json()["token"]

    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Device B"})
    tok2 = dev2.json()["token"]

    from starlette.testclient import TestClient
    client = TestClient(app)

    with client.websocket_connect(f"/ws/v1/nearby?token={tok1}") as ws1:
        # Announce Device A
        ws1.send_json({
            "type": "nearby_announce",
            "payload": {
                "display_name": "Device A",
                "device_type": "desktop",
            },
        })
        # Initial peer list for A (empty)
        msg1 = ws1.receive_json()
        assert msg1["type"] == "nearby_peer_list"
        assert len(msg1["payload"]["peers"]) == 0

        with client.websocket_connect(f"/ws/v1/nearby?token={tok2}") as ws2:
            # Announce Device B
            ws2.send_json({
                "type": "nearby_announce",
                "payload": {
                    "display_name": "Device B",
                    "device_type": "mobile",
                },
            })

            # ws2 gets peer list with A
            msg2 = ws2.receive_json()
            assert msg2["type"] == "nearby_peer_list"
            assert len(msg2["payload"]["peers"]) == 1
            peer_a = msg2["payload"]["peers"][0]
            assert peer_a["display_name"] == "Device A"
            assert peer_a["device_type"] == "desktop"
            assert peer_a["ephemeral_id"].startswith("peer_")
            # Verify no sensitive fields leaked
            assert "ip" not in peer_a
            assert "token" not in peer_a
            assert "device_id" not in peer_a

            # ws1 gets updated peer list with B
            msg1_updated = ws1.receive_json()
            assert msg1_updated["type"] == "nearby_peer_list"
            assert len(msg1_updated["payload"]["peers"]) == 1
            peer_b = msg1_updated["payload"]["peers"][0]
            assert peer_b["display_name"] == "Device B"
            assert peer_b["device_type"] == "mobile"


@pytest.mark.asyncio
async def test_nearby_request_and_accept_flow(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Device A"})
    tok1 = dev1.json()["token"]

    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Device B"})
    tok2 = dev2.json()["token"]

    from starlette.testclient import TestClient
    client = TestClient(app)

    with client.websocket_connect(f"/ws/v1/nearby?token={tok1}") as ws1:
        ws1.send_json({"type": "nearby_announce", "payload": {"display_name": "Device A", "device_type": "desktop"}})
        ws1.receive_json()

        with client.websocket_connect(f"/ws/v1/nearby?token={tok2}") as ws2:
            ws2.send_json({"type": "nearby_announce", "payload": {"display_name": "Device B", "device_type": "mobile"}})
            msg_b = ws2.receive_json()
            eph_a = msg_b["payload"]["peers"][0]["ephemeral_id"]
            ws1.receive_json()  # consume A's updated peer list

            # Device B sends request to Device A
            ws2.send_json({
                "type": "nearby_request",
                "payload": {"target_id": eph_a},
            })

            # Device A receives incoming request
            incoming = ws1.receive_json()
            assert incoming["type"] == "nearby_incoming_request"
            req_id = incoming["payload"]["request_id"]
            assert incoming["payload"]["from_device"]["display_name"] == "Device B"

            # Device A accepts the request
            ws1.send_json({
                "type": "nearby_response",
                "payload": {
                    "request_id": req_id,
                    "accepted": True,
                },
            })

            # Both devices receive nearby_paired
            paired1 = ws1.receive_json()
            paired2 = ws2.receive_json()

            assert paired1["type"] == "nearby_paired"
            assert paired2["type"] == "nearby_paired"
            assert paired1["payload"]["session_id"] == paired2["payload"]["session_id"]
            assert paired1["payload"]["role"] == "receiver"
            assert paired2["payload"]["role"] == "sender"
            assert len(paired1["payload"]["pairing_code"]) == 6


@pytest.mark.asyncio
async def test_nearby_request_and_decline_flow(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Device A"})
    tok1 = dev1.json()["token"]

    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Device B"})
    tok2 = dev2.json()["token"]

    from starlette.testclient import TestClient
    client = TestClient(app)

    with client.websocket_connect(f"/ws/v1/nearby?token={tok1}") as ws1:
        ws1.send_json({"type": "nearby_announce", "payload": {"display_name": "Device A", "device_type": "desktop"}})
        ws1.receive_json()

        with client.websocket_connect(f"/ws/v1/nearby?token={tok2}") as ws2:
            ws2.send_json({"type": "nearby_announce", "payload": {"display_name": "Device B", "device_type": "mobile"}})
            msg_b = ws2.receive_json()
            eph_a = msg_b["payload"]["peers"][0]["ephemeral_id"]
            ws1.receive_json()

            # Device B requests A
            ws2.send_json({"type": "nearby_request", "payload": {"target_id": eph_a}})
            incoming = ws1.receive_json()
            req_id = incoming["payload"]["request_id"]

            # Device A declines
            ws1.send_json({
                "type": "nearby_response",
                "payload": {
                    "request_id": req_id,
                    "accepted": False,
                },
            })

            # Device B receives rejection
            rejected = ws2.receive_json()
            assert rejected["type"] == "nearby_rejected"
            assert rejected["payload"]["request_id"] == req_id


@pytest.mark.asyncio
async def test_nearby_disconnect_cleanup(async_client: AsyncClient):
    dev1 = await async_client.post("/api/v1/devices", json={"display_name": "Device A"})
    tok1 = dev1.json()["token"]
    dev2 = await async_client.post("/api/v1/devices", json={"display_name": "Device B"})
    tok2 = dev2.json()["token"]

    from starlette.testclient import TestClient
    client = TestClient(app)

    with client.websocket_connect(f"/ws/v1/nearby?token={tok1}") as ws1:
        ws1.send_json({"type": "nearby_announce", "payload": {"display_name": "Device A", "device_type": "desktop"}})
        ws1.receive_json()

        with client.websocket_connect(f"/ws/v1/nearby?token={tok2}") as ws2:
            ws2.send_json({"type": "nearby_announce", "payload": {"display_name": "Device B", "device_type": "mobile"}})
            ws2.receive_json()
            ws1.receive_json()

        # After ws2 exits context (disconnects), ws1 should get peer_list with 0 peers
        msg1 = ws1.receive_json()
        assert msg1["type"] == "nearby_peer_list"
        assert len(msg1["payload"]["peers"]) == 0
