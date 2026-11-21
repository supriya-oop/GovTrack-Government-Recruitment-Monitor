# GovTrack — Intelligent Government Recruitment & Examination Notification Change Monitoring System

GovTrack is a full-stack recruitment intelligence and notification change-monitoring system tracking official Indian government, banking, railway, testing, and state PSC portals using SHA-256 snapshot hashing, field-level change detection, prioritized alerting, personalized aspirant matching, and strict verification provenance.

## Key Capabilities

1. **Real Snapshot Diff Engine (Zero Fake Changes)**:
   - Baseline seeding stores v1 snapshots cleanly without fabricating history.
   - Identical rescans or formatting-only HTML changes produce `0` change events.
   - Actual changes (Exam Date, Application Deadline, Application Start, Admit Card, Result, Vacancy Count, Qualification, Official PDF, Cancellation, Verified Removal) generate field-level diff records with `previous_value` and `new_value`, complete `notification_versions`, and deduplicated priority alerts (`Critical`, `High`, `Normal`, `Low`).
   - HTTP 403/404/429 or 0-row parse errors never delete existing records.
2. **13 Monitored Portals**:
   - UPSC, SSC, IBPS, SBI Careers, RRB Chandigarh, Employment News, NTA, TNPSC, Kerala PSC, RPSC, TNUSRB, RBI Opportunities, and India Post GDS.
   - Explicit offline HTML fixtures clearly labeled **DEMO DATA** for reproducible offline evaluation.
3. **Personalized Tracker ("My Opportunities") & Smart Deadline Calendar**:
   - Matches recruitments against target organizations, qualifications, job categories, preferred states, and target exams with transparent match reasons.
   - Monthly calendar and countdown tracker for deadlines, exams, admit cards, and results.
4. **Role-Based Access & Admin Console**:
   - Backend-enforced JWT + bcrypt authentication (`admin@govtrack.in` / `Admin@2026`, `aspirant@govtrack.in` / `Aspirant@2026`).
   - Admin panel for source CRUD, scheduler configuration, run & failure logs, category management, change verification, and user management.

## Running Locally

### Option 1: Unified Node.js + Vite Server (Recommended Quickstart)
```bash
npm install
npm run dev
# Opens http://localhost:3000
```

### Option 2: Python FastAPI + React Vite (Windows / Linux)
- On Windows, double-click `setup_windows.bat` then `start_windows.bat`.
- Or manually:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
In a second terminal:
```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:8000 npm run dev:frontend
```

## Automated Tests
```bash
python3 -m unittest discover -s backend/tests -v
```
