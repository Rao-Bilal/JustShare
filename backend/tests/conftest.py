import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.db.session import get_db_session
from app.main import app as fastapi_app
from app.models.base import Base

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
TestingSessionLocal = async_sessionmaker(autocommit=False, autoflush=False, bind=engine, class_=AsyncSession)

async def override_get_db_session():
    async with TestingSessionLocal() as session:
        yield session

fastapi_app.dependency_overrides[get_db_session] = override_get_db_session

def override_get_settings():
    settings = get_settings()
    settings.use_sqlite = True
    settings.jwt_secret = "test_secret_must_be_at_least_32_bytes_long_for_security_checks"
    return settings

fastapi_app.dependency_overrides[get_settings] = override_get_settings

@pytest_asyncio.fixture(autouse=True)
async def db_setup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

@pytest_asyncio.fixture
async def async_client():
    async with AsyncClient(transport=ASGITransport(app=fastapi_app), base_url="http://testserver") as client:
        yield client
