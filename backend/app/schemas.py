from typing import Any, List, Optional
from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    full_name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    target_exams: Optional[str] = "UPSC, SSC, IBPS"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ProfileUpdateRequest(BaseModel):
    full_name: Optional[str] = Field(None, min_length=2, max_length=120)
    target_exams: Optional[Any] = None
    target_organizations: Optional[List[str]] = None
    qualification: Optional[str] = None
    job_categories: Optional[List[str]] = None
    preferred_states: Optional[List[str]] = None
    alert_priorities: Optional[List[str]] = None
    saved_only_alerts: Optional[bool] = None
    email_alerts_enabled: Optional[bool] = None
    dark_mode: Optional[bool] = None
    dashboard_page_size: Optional[int] = Field(None, ge=5, le=50)


class PasswordUpdateRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=6, max_length=128)


class SaveBookmarkRequest(BaseModel):
    notes: Optional[str] = None


class SourceScrapeRequest(BaseModel):
    mode: Optional[str] = None
    fixture: Optional[str] = None
    simulate_status: Optional[int] = None


class SourceCreateRequest(BaseModel):
    code: str = Field(..., min_length=2, max_length=40)
    name: str
    organization_name: str
    base_url: str
    source_type: str = "HTML Scraper"
    parser_key: Optional[str] = None
    fixture_filename: Optional[str] = None
    scrape_mode: str = "auto"
    crawl_interval_minutes: int = Field(360, ge=15, le=10080)
    rate_limit_seconds: int = Field(2, ge=1, le=30)
    robots_policy: Optional[str] = None
    permission_note: Optional[str] = None


class SourceConfigUpdateRequest(BaseModel):
    name: Optional[str] = None
    base_url: Optional[str] = None
    source_type: Optional[str] = None
    is_active: Optional[bool] = None
    scrape_mode: Optional[str] = None
    crawl_interval_minutes: Optional[int] = Field(None, ge=15, le=10080)
    rate_limit_seconds: Optional[int] = Field(None, ge=1, le=30)


class SchedulerUpdateRequest(BaseModel):
    interval_minutes: Optional[int] = Field(None, ge=15, le=10080)
    enabled: Optional[bool] = None


class AdminUserUpdateRequest(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None


class CategoryCreateRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    description: Optional[str] = None
