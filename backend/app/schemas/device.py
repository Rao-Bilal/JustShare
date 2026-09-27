from pydantic import BaseModel, Field


class DeviceCreate(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=128)

class DeviceResponse(BaseModel):
    device_id: str
    display_name: str
    token: str
