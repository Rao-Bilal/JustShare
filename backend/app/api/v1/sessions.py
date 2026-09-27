import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_device_id
from app.core.config import get_settings
from app.core.security import generate_pairing_code
from app.db.session import get_db_session
from app.models.device import Device
from app.models.transfer_session import TransferSession
from app.schemas.session import (
    DeviceInfo,
    SessionDetailResponse,
    SessionJoinRequest,
    SessionJoinResponse,
    SessionResponse,
    StateUpdateRequest,
    StateUpdateResponse,
)

router = APIRouter()

VALID_TRANSITIONS = {
    "WAITING_FOR_PEER": {"PAIRED", "CANCELLED", "EXPIRED"},
    "PAIRED": {"AWAITING_APPROVAL", "CANCELLED"},
    "AWAITING_APPROVAL": {"CONNECTING", "REJECTED", "CANCELLED"},
    "CONNECTING": {"TRANSFERRING", "FAILED", "CANCELLED"},
    "TRANSFERRING": {"VERIFYING", "FAILED", "CANCELLED"},
    "VERIFYING": {"COMPLETED", "FAILED"},
    "REJECTED": {"CANCELLED"},
    "FAILED": {"CANCELLED"},
    "COMPLETED": {"CANCELLED"},
    "CANCELLED": set(),
    "EXPIRED": set()
}

def _make_naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt

@router.post("", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    device_id: str = Depends(get_current_device_id),
    db: AsyncSession = Depends(get_db_session)
):
    settings = get_settings()
    now = datetime.now(UTC)
    expires_at = now + timedelta(minutes=settings.session_expiry_minutes)
    pairing_expires_at = now + timedelta(minutes=settings.pairing_code_expiry_minutes)
    
    session_obj = TransferSession(
        sender_device_id=uuid.UUID(device_id),
        pairing_code=generate_pairing_code(),
        pairing_expires_at=pairing_expires_at,
        expires_at=expires_at,
        state="WAITING_FOR_PEER",
        max_pairing_attempts=settings.max_pairing_attempts
    )
    db.add(session_obj)
    await db.commit()
    await db.refresh(session_obj)
    
    return SessionResponse(
        session_id=str(session_obj.id),
        pairing_code=session_obj.pairing_code,
        expires_at=session_obj.expires_at.isoformat(),
        state=session_obj.state
    )

@router.post("/join", response_model=SessionJoinResponse)
async def join_session(
    request: SessionJoinRequest,
    device_id: str = Depends(get_current_device_id),
    db: AsyncSession = Depends(get_db_session)
):
    now_naive = datetime.now(UTC).replace(tzinfo=None)
    stmt = select(TransferSession).where(
        TransferSession.pairing_code == request.pairing_code,
        TransferSession.state == "WAITING_FOR_PEER"
    )
    result = await db.execute(stmt)
    session_obj = result.scalars().first()
    
    if not session_obj:
        return JSONResponse(status_code=404, content={"error": {"code": "INVALID_CODE", "message": "Invalid pairing code"}})
    
    if str(session_obj.sender_device_id) == device_id:
        return JSONResponse(status_code=400, content={"error": {"code": "INVALID_CODE", "message": "Cannot join own session"}})
    
    if session_obj.pairing_attempts >= session_obj.max_pairing_attempts:
        return JSONResponse(status_code=429, content={"error": {"code": "TOO_MANY_ATTEMPTS", "message": "Too many attempts"}})
        
    pairing_exp = _make_naive(session_obj.pairing_expires_at)
    if pairing_exp and pairing_exp < now_naive:
        return JSONResponse(status_code=400, content={"error": {"code": "SESSION_EXPIRED", "message": "Pairing code expired"}})
        
    session_obj.receiver_device_id = uuid.UUID(device_id)
    session_obj.state = "PAIRED"
    session_obj.pairing_code = None
    
    await db.commit()
    await db.refresh(session_obj)
    
    sender_stmt = select(Device).where(Device.id == session_obj.sender_device_id)
    sender = (await db.execute(sender_stmt)).scalars().first()
    
    return SessionJoinResponse(
        session_id=str(session_obj.id),
        state=session_obj.state,
        sender=DeviceInfo(device_id=str(sender.id), display_name=sender.display_name)
    )

@router.get("/{session_id}", response_model=SessionDetailResponse)
async def get_session(
    session_id: str,
    device_id: str = Depends(get_current_device_id),
    db: AsyncSession = Depends(get_db_session)
):
    stmt = select(TransferSession).where(TransferSession.id == uuid.UUID(session_id))
    session_obj = (await db.execute(stmt)).scalars().first()
    
    if not session_obj:
        raise HTTPException(status_code=404, detail="Session not found")
        
    if str(session_obj.sender_device_id) != device_id and str(session_obj.receiver_device_id) != device_id:
        raise HTTPException(status_code=403, detail="Not a participant")
        
    sender = (await db.execute(select(Device).where(Device.id == session_obj.sender_device_id))).scalars().first()
    receiver = None
    if session_obj.receiver_device_id:
        receiver = (await db.execute(select(Device).where(Device.id == session_obj.receiver_device_id))).scalars().first()
        
    return SessionDetailResponse(
        session_id=str(session_obj.id),
        state=session_obj.state,
        sender=DeviceInfo(device_id=str(sender.id), display_name=sender.display_name),
        receiver=DeviceInfo(device_id=str(receiver.id), display_name=receiver.display_name) if receiver else None,
        created_at=session_obj.created_at.isoformat(),
        expires_at=session_obj.expires_at.isoformat()
    )

@router.patch("/{session_id}/state", response_model=StateUpdateResponse)
async def update_session_state(
    session_id: str,
    request: StateUpdateRequest,
    device_id: str = Depends(get_current_device_id),
    db: AsyncSession = Depends(get_db_session)
):
    stmt = select(TransferSession).where(TransferSession.id == uuid.UUID(session_id))
    session_obj = (await db.execute(stmt)).scalars().first()
    
    if not session_obj:
        raise HTTPException(status_code=404, detail="Session not found")
        
    if str(session_obj.sender_device_id) != device_id and str(session_obj.receiver_device_id) != device_id:
        raise HTTPException(status_code=403, detail="Not a participant")
        
    new_state = request.state
    if new_state == "CANCELLED":
        pass
    elif new_state not in VALID_TRANSITIONS.get(session_obj.state, set()):
        raise HTTPException(status_code=400, detail="Invalid state transition")
        
    session_obj.state = new_state
    await db.commit()
    await db.refresh(session_obj)
    
    return StateUpdateResponse(
        session_id=str(session_obj.id),
        state=session_obj.state
    )
