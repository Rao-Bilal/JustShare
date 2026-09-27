from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Import all models to ensure metadata is complete
from app.core.config import get_settings
from app.models.base import Base

settings = get_settings()
_engine: AsyncEngine | None = None

def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        if settings.use_sqlite or "sqlite" in settings.database_url:
            url = f"sqlite+aiosqlite:///{settings.sqlite_path}" if "sqlite" not in settings.database_url else settings.database_url
            _engine = create_async_engine(url, pool_pre_ping=True)
        else:
            _engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    return _engine

async def create_tables():
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db_session():
    session_factory = async_sessionmaker(get_engine(), class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
