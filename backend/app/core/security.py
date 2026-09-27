import secrets
from datetime import UTC, datetime, timedelta

import jwt


def create_device_token(device_id: str, secret: str, expires_hours: int = 24) -> str:
    expires_at = datetime.now(UTC) + timedelta(hours=expires_hours)
    payload = {
        "device_id": device_id,
        "exp": int(expires_at.timestamp())
    }
    return jwt.encode(payload, secret, algorithm="HS256")

def decode_device_token(token: str, secret: str) -> dict:
    return jwt.decode(token, secret, algorithms=["HS256"])

def generate_pairing_code() -> str:
    return f"{secrets.randbelow(1000000):06d}"
