import json
import uuid

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import decode_device_token
from app.db.session import get_db_session
from app.models.device import Device
from app.models.transfer_session import TransferSession

router = APIRouter()

active_connections: dict[str, dict[str, WebSocket]] = {}

@router.websocket("/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str, token: str = Query(...)):
    await websocket.accept()
    settings = get_settings()
    
    try:
        payload = decode_device_token(token, settings.jwt_secret)
        device_id = payload["device_id"]
    except Exception:
        await websocket.send_json({"type": "error", "payload": {"code": "UNAUTHORIZED", "message": "Invalid token"}})
        await websocket.close(code=1008)
        return

    # Verify participation
    async for db in get_db_session():
        stmt = select(TransferSession).where(TransferSession.id == uuid.UUID(session_id))
        session_obj = (await db.execute(stmt)).scalars().first()
        if not session_obj:
            await websocket.send_json({"type": "error", "payload": {"code": "NOT_FOUND", "message": "Session not found"}})
            await websocket.close(code=1008)
            return
            
        if str(session_obj.sender_device_id) != device_id and str(session_obj.receiver_device_id) != device_id:
            await websocket.send_json({"type": "error", "payload": {"code": "FORBIDDEN", "message": "Not a participant"}})
            await websocket.close(code=1008)
            return
        break
        
    if session_id not in active_connections:
        active_connections[session_id] = {}
        
    active_connections[session_id][device_id] = websocket
    
    # Notify peer and self if existing peers are present
    for other_device_id, other_ws in list(active_connections[session_id].items()):
        if other_device_id != device_id:
            try:
                async for db in get_db_session():
                    my_stmt = select(Device).where(Device.id == uuid.UUID(device_id))
                    me = (await db.execute(my_stmt)).scalars().first()
                    display_name = me.display_name if me else "Peer"

                    other_stmt = select(Device).where(Device.id == uuid.UUID(other_device_id))
                    other = (await db.execute(other_stmt)).scalars().first()
                    other_display_name = other.display_name if other else "Peer"
                    break

                await other_ws.send_json({"type": "peer_joined", "payload": {"device_id": device_id, "display_name": display_name}})
                await websocket.send_json({"type": "peer_joined", "payload": {"device_id": other_device_id, "display_name": other_display_name}})
            except Exception:
                pass
    
    try:
        while True:
            text_data = await websocket.receive_text()
            if len(text_data) > 65536:
                await websocket.send_json({"type": "error", "payload": {"code": "MESSAGE_TOO_LARGE", "message": "Message exceeds 64KB"}})
                continue
                
            try:
                data = json.loads(text_data)
            except json.JSONDecodeError:
                continue
                
            msg_type = data.get("type")
            payload = data.get("payload", {})
            
            if msg_type in ["signal", "file_metadata", "transfer_response", "state_update"]:
                out_msg = {
                    "type": msg_type,
                    "from": device_id,
                    "payload": payload
                }
                for other_device_id, other_ws in active_connections[session_id].items():
                    if other_device_id != device_id:
                        await other_ws.send_json(out_msg)
                        
    except WebSocketDisconnect:
        if session_id in active_connections and device_id in active_connections[session_id]:
            del active_connections[session_id][device_id]
            if not active_connections[session_id]:
                del active_connections[session_id]
            else:
                for other_ws in active_connections[session_id].values():
                    try:
                        await other_ws.send_json({"type": "peer_left", "payload": {"device_id": device_id}})
                    except Exception:
                        pass
