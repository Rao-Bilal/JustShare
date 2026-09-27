from pydantic import BaseModel, Field


class SessionCreate(BaseModel):
    pass

class SessionResponse(BaseModel):
    session_id: str
    pairing_code: str
    expires_at: str
    state: str

class DeviceInfo(BaseModel):
    device_id: str
    display_name: str

class SessionJoinRequest(BaseModel):
    pairing_code: str = Field(..., pattern=r'^\d{6}$')

class SessionJoinResponse(BaseModel):
    session_id: str
    state: str
    sender: DeviceInfo

class SessionDetailResponse(BaseModel):
    session_id: str
    state: str
    sender: DeviceInfo
    receiver: DeviceInfo | None
    created_at: str
    expires_at: str

class StateUpdateRequest(BaseModel):
    state: str

class StateUpdateResponse(BaseModel):
    session_id: str
    state: str
