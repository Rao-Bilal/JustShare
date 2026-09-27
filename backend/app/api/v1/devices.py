from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import create_device_token
from app.db.session import get_db_session
from app.models.device import Device
from app.schemas.device import DeviceCreate, DeviceResponse

router = APIRouter()

@router.post("", response_model=DeviceResponse, status_code=status.HTTP_201_CREATED)
async def create_device(device_in: DeviceCreate, db: AsyncSession = Depends(get_db_session)):
    settings = get_settings()
    device = Device(display_name=device_in.display_name)
    db.add(device)
    await db.commit()
    await db.refresh(device)
    
    device_id_str = str(device.id)
    token = create_device_token(device_id_str, settings.jwt_secret)
    
    return DeviceResponse(
        device_id=device_id_str,
        display_name=device.display_name,
        token=token
    )
