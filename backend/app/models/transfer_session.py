import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TransferSession(Base):
    __tablename__ = "transfer_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    sender_device_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("devices.id"), nullable=False)
    receiver_device_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("devices.id"), nullable=True)
    state: Mapped[str] = mapped_column(String(32), default="WAITING_FOR_PEER")
    pairing_code: Mapped[str | None] = mapped_column(String(6), nullable=True, index=True)
    pairing_attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_pairing_attempts: Mapped[int] = mapped_column(Integer, default=5)
    pairing_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    files_metadata: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
