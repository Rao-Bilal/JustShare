import jwt
from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings
from app.core.security import decode_device_token

security = HTTPBearer(auto_error=False)

def get_current_device_id(credentials: HTTPAuthorizationCredentials | None = Security(security)) -> str:
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required")
        
    settings = get_settings()
    try:
        payload = decode_device_token(credentials.credentials, settings.jwt_secret)
        return payload["device_id"]
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(status_code=401, detail="Token has expired") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail="Invalid token") from e
