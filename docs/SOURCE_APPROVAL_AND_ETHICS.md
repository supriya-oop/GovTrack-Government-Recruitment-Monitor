# Source Approval, Respectful Crawling & Data Ethics

1. **Public Official Portals Only**: GovTrack monitors strictly public-facing recruitment & notice pages of official Indian commissions, banking bodies, railways, testing agencies, and state PSCs.
2. **Respectful Crawling Controls**:
   - Checks `/robots.txt` prior to live HTTP fetches.
   - Identifies itself clearly with `GovTrackMonitor/1.0 (+Academic-Research-Project; respectful-crawler)`.
   - Enforces rate limiting (`>= 2s`) and immediately aborts on HTTP `403`, `429`, or anti-bot/CAPTCHA challenges without bypass attempts.
3. **Stale-Data Protection & Truthfulness**:
   - Failed scrapes or 0-row parser outputs preserve all existing database records untouched.
   - Unavailable dates, vacancy counts, or PDFs are stored as `NULL` and displayed as `"Not available"`.
   - Offline HTML fixtures used in demo mode are explicitly labeled `DEMO DATA`.
4. **Informational Disclaimer**: GovTrack is an automated monitoring tool; candidates must always verify final eligibility and dates on the official source portal or PDF before applying.
