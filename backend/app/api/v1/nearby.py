import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import decode_device_token, generate_pairing_code
from app.db.session import get_db_session
from app.models.transfer_session import TransferSession

router = APIRouter()
logger = logging.getLogger(__name__)

# Discovery TTL in seconds (60-90s requirement)
PRESENCE_TTL_SECONDS = 90.0

@dataclass
class NearbyPeer:
    ephemeral_id: str
    device_id: str
    display_name: str
    device_type: str
    group_hash: str
    websocket: WebSocket
    last_seen: float = field(default_factory=time.time)

@dataclass
class PendingPairRequest:
    request_id: str
    requester_ephemeral_id: str
    requester_device_id: str
    target_ephemeral_id: str
    target_device_id: str
    created_at: float = field(default_factory=time.time)

class NearbyDiscoveryManager:
    """
    In-memory, ephemeral discovery room manager.
    Groups devices strictly by server-side HMAC of client public IP.
    No persistent database records, no raw IP disclosure to clients.
    """
    def __init__(self):
        # group_hash -> { ephemeral_id: NearbyPeer }
        self._groups: dict[str, dict[str, NearbyPeer]] = {}
        # ephemeral_id -> group_hash
        self._ephemeral_to_group: dict[str, str] = {}
        # websocket -> ephemeral_id
        self._ws_to_ephemeral: dict[WebSocket, str] = {}
        # request_id -> PendingPairRequest
        self._pending_requests: dict[str, PendingPairRequest] = {}
        self._lock = asyncio.Lock()

    def _hash_ip(self, ip: str, secret: str) -> str:
        """
        Creates a private HMAC of the client public IP using server JWT secret.
        The resulting hash is never sent to the client.
        """
        return hmac.new(secret.encode("utf-8"), ip.encode("utf-8"), hashlib.sha256).hexdigest()

    async def register_peer(
        self,
        websocket: WebSocket,
        device_id: str,
        display_name: str,
        device_type: str,
        client_ip: str,
        secret: str,
    ) -> str:
        async with self._lock:
            # Clean expired peers first
            self._cleanup_expired_unlocked()

            # If this websocket was previously registered, remove old entry
            if websocket in self._ws_to_ephemeral:
                self._remove_peer_by_ws_unlocked(websocket)

            group_hash = self._hash_ip(client_ip, secret)
            ephemeral_id = f"peer_{uuid.uuid4().hex[:8]}"

            peer = NearbyPeer(
                ephemeral_id=ephemeral_id,
                device_id=device_id,
                display_name=display_name.strip()[:50] or "Nearby Device",
                device_type=device_type.strip()[:30] or "unknown",
                group_hash=group_hash,
                websocket=websocket,
                last_seen=time.time(),
            )

            if group_hash not in self._groups:
                self._groups[group_hash] = {}

            self._groups[group_hash][ephemeral_id] = peer
            self._ephemeral_to_group[ephemeral_id] = group_hash
            self._ws_to_ephemeral[websocket] = ephemeral_id

            await self._broadcast_group_peer_list_unlocked(group_hash)
            return ephemeral_id

    async def remove_peer(self, websocket: WebSocket) -> None:
        async with self._lock:
            group_hash = self._remove_peer_by_ws_unlocked(websocket)
            if group_hash:
                await self._broadcast_group_peer_list_unlocked(group_hash)

    def _remove_peer_by_ws_unlocked(self, websocket: WebSocket) -> str | None:
        ephemeral_id = self._ws_to_ephemeral.pop(websocket, None)
        if not ephemeral_id:
            return None

        group_hash = self._ephemeral_to_group.pop(ephemeral_id, None)
        if group_hash and group_hash in self._groups:
            self._groups[group_hash].pop(ephemeral_id, None)
            if not self._groups[group_hash]:
                del self._groups[group_hash]

        # Clean pending requests involving this peer
        to_delete = [
            req_id
            for req_id, req in self._pending_requests.items()
            if req.requester_ephemeral_id == ephemeral_id or req.target_ephemeral_id == ephemeral_id
        ]
        for req_id in to_delete:
            del self._pending_requests[req_id]

        return group_hash

    def _cleanup_expired_unlocked(self) -> None:
        now = time.time()
        expired_groups: set[str] = set()

        for group_hash, peers in list(self._groups.items()):
            for eph_id, peer in list(peers.items()):
                if now - peer.last_seen > PRESENCE_TTL_SECONDS:
                    del peers[eph_id]
                    self._ephemeral_to_group.pop(eph_id, None)
                    self._ws_to_ephemeral.pop(peer.websocket, None)
                    expired_groups.add(group_hash)
            if not peers:
                del self._groups[group_hash]

        # Clean expired pair requests (>60s)
        for req_id, req in list(self._pending_requests.items()):
            if now - req.created_at > 60.0:
                del self._pending_requests[req_id]

    async def _broadcast_group_peer_list_unlocked(self, group_hash: str) -> None:
        if group_hash not in self._groups:
            return

        peers = self._groups[group_hash]
        for eph_id, target_peer in list(peers.items()):
            other_peers = [
                {
                    "ephemeral_id": p.ephemeral_id,
                    "display_name": p.display_name,
                    "device_type": p.device_type,
                }
                for p_id, p in peers.items()
                if p_id != eph_id
            ]
            msg = {
                "type": "nearby_peer_list",
                "payload": {
                    "peers": other_peers,
                },
            }
            try:
                await target_peer.websocket.send_json(msg)
            except Exception:
                # Disconnect will trigger full cleanup
                pass

    async def handle_request(
        self,
        websocket: WebSocket,
        target_ephemeral_id: str,
    ) -> None:
        async with self._lock:
            requester_eph = self._ws_to_ephemeral.get(websocket)
            if not requester_eph:
                await websocket.send_json({"type": "error", "payload": {"code": "NOT_ANNOUNCED", "message": "Announce presence first"}})
                return

            group_hash = self._ephemeral_to_group.get(requester_eph)
            if not group_hash or group_hash not in self._groups:
                await websocket.send_json({"type": "error", "payload": {"code": "INVALID_GROUP", "message": "Discovery group expired"}})
                return

            requester_peer = self._groups[group_hash].get(requester_eph)
            target_peer = self._groups[group_hash].get(target_ephemeral_id)

            if not requester_peer or not target_peer or requester_eph == target_ephemeral_id:
                await websocket.send_json({"type": "error", "payload": {"code": "PEER_NOT_FOUND", "message": "Peer unavailable"}})
                return

            # Update last_seen
            requester_peer.last_seen = time.time()
            target_peer.last_seen = time.time()

            request_id = str(uuid.uuid4())
            self._pending_requests[request_id] = PendingPairRequest(
                request_id=request_id,
                requester_ephemeral_id=requester_eph,
                requester_device_id=requester_peer.device_id,
                target_ephemeral_id=target_ephemeral_id,
                target_device_id=target_peer.device_id,
            )

            # Send incoming request to target peer
            incoming_msg = {
                "type": "nearby_incoming_request",
                "payload": {
                    "request_id": request_id,
                    "from_device": {
                        "ephemeral_id": requester_peer.ephemeral_id,
                        "display_name": requester_peer.display_name,
                        "device_type": requester_peer.device_type,
                    },
                },
            }
            try:
                await target_peer.websocket.send_json(incoming_msg)
            except Exception:
                await websocket.send_json({"type": "error", "payload": {"code": "SEND_FAILED", "message": "Target peer disconnected"}})

    async def handle_response(
        self,
        websocket: WebSocket,
        request_id: str,
        accepted: bool,
    ) -> tuple[PendingPairRequest, WebSocket, WebSocket] | None:
        async with self._lock:
            req = self._pending_requests.pop(request_id, None)
            if not req:
                await websocket.send_json({"type": "error", "payload": {"code": "INVALID_REQUEST_ID", "message": "Request expired or invalid"}})
                return None

            responder_eph = self._ws_to_ephemeral.get(websocket)
            if responder_eph != req.target_ephemeral_id:
                await websocket.send_json({"type": "error", "payload": {"code": "FORBIDDEN", "message": "Not the targeted peer"}})
                return None

            group_hash = self._ephemeral_to_group.get(responder_eph)
            if not group_hash or group_hash not in self._groups:
                return None

            requester_peer = self._groups[group_hash].get(req.requester_ephemeral_id)
            target_peer = self._groups[group_hash].get(req.target_ephemeral_id)

            if not requester_peer or not target_peer:
                return None

            if not accepted:
                # Notify requester of decline
                decline_msg = {
                    "type": "nearby_rejected",
                    "payload": {
                        "request_id": request_id,
                        "from_ephemeral_id": responder_eph,
                        "message": "Connection request declined by peer",
                    },
                }
                try:
                    await requester_peer.websocket.send_json(decline_msg)
                except Exception:
                    pass
                return None

            # Accepted: return peers to create session
            return req, requester_peer.websocket, target_peer.websocket


discovery_manager = NearbyDiscoveryManager()


def get_client_ip(websocket: WebSocket) -> str:
    # Handle X-Forwarded-For if behind a proxy
    forwarded = websocket.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if websocket.client and websocket.client.host:
        return websocket.client.host
    return "127.0.0.1"


@router.websocket("")
async def nearby_websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    await websocket.accept()
    settings = get_settings()

    try:
        payload = decode_device_token(token, settings.jwt_secret)
        device_id = payload["device_id"]
    except Exception:
        await websocket.send_json({"type": "error", "payload": {"code": "UNAUTHORIZED", "message": "Invalid token"}})
        await websocket.close(code=1008)
        return

    client_ip = get_client_ip(websocket)

    try:
        while True:
            text_data = await websocket.receive_text()
            if len(text_data) > 16384:
                await websocket.send_json({"type": "error", "payload": {"code": "MESSAGE_TOO_LARGE", "message": "Payload too large"}})
                continue

            try:
                data = json.loads(text_data)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "payload": {"code": "INVALID_JSON", "message": "Malformed JSON"}})
                continue

            msg_type = data.get("type")
            msg_payload = data.get("payload", {})

            if msg_type == "nearby_announce":
                display_name = str(msg_payload.get("display_name", ""))
                device_type = str(msg_payload.get("device_type", "unknown"))
                await discovery_manager.register_peer(
                    websocket=websocket,
                    device_id=device_id,
                    display_name=display_name,
                    device_type=device_type,
                    client_ip=client_ip,
                    secret=settings.jwt_secret,
                )

            elif msg_type == "nearby_request":
                target_ephemeral_id = str(msg_payload.get("target_id", ""))
                if not target_ephemeral_id:
                    await websocket.send_json({"type": "error", "payload": {"code": "INVALID_PAYLOAD", "message": "Missing target_id"}})
                    continue
                await discovery_manager.handle_request(websocket, target_ephemeral_id)

            elif msg_type == "nearby_response":
                request_id = str(msg_payload.get("request_id", ""))
                accepted = bool(msg_payload.get("accepted", False))
                if not request_id:
                    await websocket.send_json({"type": "error", "payload": {"code": "INVALID_PAYLOAD", "message": "Missing request_id"}})
                    continue

                res = await discovery_manager.handle_response(websocket, request_id, accepted)
                if res:
                    pair_req, sender_ws, receiver_ws = res
                    # Create standard transfer session using existing schema & logic
                    async for db in get_db_session():
                        now = datetime.now(UTC)
                        expires_at = now + timedelta(minutes=settings.session_expiry_minutes)
                        pairing_expires_at = now + timedelta(minutes=settings.pairing_code_expiry_minutes)

                        session_obj = TransferSession(
                            sender_device_id=uuid.UUID(pair_req.requester_device_id),
                            receiver_device_id=uuid.UUID(pair_req.target_device_id),
                            pairing_code=generate_pairing_code(),
                            pairing_expires_at=pairing_expires_at,
                            expires_at=expires_at,
                            state="PAIRED",
                            max_pairing_attempts=settings.max_pairing_attempts,
                        )
                        db.add(session_obj)
                        await db.commit()
                        await db.refresh(session_obj)

                        session_id = str(session_obj.id)
                        pairing_code = session_obj.pairing_code

                        # Send nearby_paired event to both devices
                        sender_msg = {
                            "type": "nearby_paired",
                            "payload": {
                                "session_id": session_id,
                                "pairing_code": pairing_code,
                                "role": "sender",
                                "peer_ephemeral_id": pair_req.target_ephemeral_id,
                            },
                        }
                        receiver_msg = {
                            "type": "nearby_paired",
                            "payload": {
                                "session_id": session_id,
                                "pairing_code": pairing_code,
                                "role": "receiver",
                                "peer_ephemeral_id": pair_req.requester_ephemeral_id,
                            },
                        }

                        try:
                            await sender_ws.send_json(sender_msg)
                        except Exception:
                            pass
                        try:
                            await receiver_ws.send_json(receiver_msg)
                        except Exception:
                            pass
                        break

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            else:
                await websocket.send_json({"type": "error", "payload": {"code": "UNKNOWN_MESSAGE_TYPE", "message": f"Unknown message type: {msg_type}"}})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("Nearby WebSocket error: %s", e)
    finally:
        await discovery_manager.remove_peer(websocket)
