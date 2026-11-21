import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("GOVTRACK_DATABASE_URL", f"sqlite:///{(BASE_DIR.parent / 'govtrack_py.db').as_posix()}")
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "govtrack-local-dev-secret-change-in-prod")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "720"))

SCRAPER_USER_AGENT = os.getenv(
    "SCRAPER_USER_AGENT",
    "GovTrackMonitor/1.0 (+Academic-Research-Project; respectful-crawler)",
)
SCRAPER_REQUEST_TIMEOUT_SECONDS = int(os.getenv("SCRAPER_REQUEST_TIMEOUT_SECONDS", "12"))
SCHEDULER_INTERVAL_MINUTES = int(os.getenv("SCRAPER_DEFAULT_INTERVAL_MINUTES", "360"))
FIXTURES_DIR = BASE_DIR / "fixtures"

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000",
    ).split(",")
    if origin.strip()
]
