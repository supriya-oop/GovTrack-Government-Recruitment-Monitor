import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { appendMonitoringLog, applyScrapeResults, recordFailedScrape } from './changeDetector.ts';
import {
  extractIbpsSubpageDates,
  getParser,
  parseKeralaPscGazetteSubpage,
  parseNtaExamCalendarPdfText,
  parseRbiDetailHtml,
  parseTnpscAnnualPlannerHtml,
  parseTnpscDashboardDetailHtml,
  parseUpscDetailHtml,
} from './scrapers/index.ts';
import {
  enrichNotificationFromPdf,
  extractTextFromPdfBuffer,
  fetchOfficialPdfBuffer,
  fetchWithRetry,
  USER_AGENT,
} from './pdfExtractor.ts';
import type { ParsedNotification } from './scrapers/base.ts';

const FIXTURES_DIR = path.resolve(process.cwd(), 'backend', 'fixtures');
const CAPTCHA_MARKERS = ['captcha', 'cf-challenge', 'g-recaptcha', 'hcaptcha', 'access denied'];
const WAF_MARKERS = ["this page can't be displayed", 'the incident id is:', 'request blocked by firewall', 'window["bobcmn"]', '/tspd/'];

const RRB_FALLBACK_MIRRORS = [
  'https://www.rrbcdg.gov.in/',
  'https://www.rrbchennai.gov.in/',
  'https://www.rrbbnc.gov.in/',
  'https://www.rrbkolkata.gov.in/',
  'https://rrbajmer.gov.in/',
  'https://rrbsecunderabad.gov.in/',
];

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(slice.map((item, j) => worker(item, i + j)));
    out.push(...batchResults);
  }
  return out;
}

async function fetchHtml(url: string, timeoutMs = 12000): Promise<{ status: number; text: string }> {
  const resp = await fetchWithRetry(url, {
    timeoutMs,
    retries: 2,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
    },
  });
  const text = resp.status === 200 ? await resp.text() : '';
  return { status: resp.status, text };
}

interface SscApiRecord {
  id?: string;
  headline?: string;
  examId?: string;
  examYear?: string;
  desc?: string;
  content?: string;
  startDate?: string | null;
  endDate?: string | null;
  createdAt?: string | null;
  redirectUrl?: string | null;
  attachments?: { path?: string; fileName?: string; type?: string }[];
}

async function fetchSscLiveItems(): Promise<ParsedNotification[]> {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Referer: 'https://ssc.gov.in/',
  };
  const noticeUrl =
    'https://ssc.gov.in/api/general-website/portal/notice-boards?page=1&limit=28&contentType=notice-boards&key=createdAt&order=DESC&isPaginationRequired=true&isAttachment=true&language=english&attributes=id,headline,examId,contentType,redirectUrl,createdAt';
  const calendarUrl =
    'https://ssc.gov.in/api/general-website/portal/ssc-calendar?page=1&limit=18&contentType=ssc-calendar&key=createdAt&order=DESC&isPaginationRequired=false&isAttachment=true&language=english&attributes=id,headline,examId,examYear,desc,content,contentType,startDate,endDate,language,createdAt';

  const results: ParsedNotification[] = [];
  const seen = new Set<string>();

  const safeFetchJson = async (url: string): Promise<SscApiRecord[]> => {
    try {
      const resp = await fetchWithRetry(url, { timeoutMs: 11000, retries: 1, headers });
      if (!resp.ok) return [];
      const payload = (await resp.json()) as { statusCode?: string; data?: SscApiRecord[] };
      return Array.isArray(payload?.data) ? payload.data : [];
    } catch {
      return [];
    }
  };

  const [notices, calendar] = await Promise.all([safeFetchJson(noticeUrl), safeFetchJson(calendarUrl)]);

  // Index exam month/window by examId so notices can inherit calendar dates where applicable
  const calendarByExamId = new Map<string, SscApiRecord>();
  for (const cal of calendar) {
    if (cal.examId && !calendarByExamId.has(String(cal.examId))) {
      calendarByExamId.set(String(cal.examId), cal);
    }
  }

  for (const row of notices) {
    const title = row.headline ? row.headline.replace(/\s+/g, ' ').trim() : '';
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    const att = row.attachments?.find((a) => a.path && /\.pdf$/i.test(a.path)) || row.attachments?.[0];
    const cleanPath = att?.path ? att.path.replace(/\\/g, '/').replace(/^\/+/, '') : null;
    const pdfUrl = cleanPath ? `https://ssc.gov.in/api/attachment/${encodeURI(cleanPath)}` : null;
    const pubDate = row.createdAt ? row.createdAt.slice(0, 10) : null;
    const calMatch = row.examId ? calendarByExamId.get(String(row.examId)) : undefined;
    const startDate = (row.startDate || calMatch?.startDate)?.slice(0, 10) || null;
    const deadline = (row.endDate || calMatch?.endDate)?.slice(0, 10) || null;
    const isAdmit = /admit|admission\s*certificate|city\s*of\s*examination/i.test(title);
    const isResult = /result|answer\s*key|marks|cut-?off/i.test(title);

    results.push({
      title,
      organization_name: 'Staff Selection Commission (SSC)',
      notification_number: row.examId ? `SSC-${row.examId}` : null,
      vacancy_count: null,
      job_category: isAdmit ? 'Admit Card / City Intimation' : isResult ? 'Result / Answer Key' : 'SSC Notice Board',
      qualification: null,
      state: 'All India',
      application_start_date: startDate,
      application_deadline: deadline,
      exam_date: calMatch?.content ? calMatch.content.trim() : null,
      admit_card_date: isAdmit ? pubDate : null,
      result_date: isResult ? pubDate : null,
      description: pubDate ? `Official SSC Notice Board update released on ${pubDate}.` : null,
      pdf_url: pdfUrl,
      source_url: 'https://ssc.gov.in/',
      published_date: pubDate,
    });
  }

  for (const row of calendar) {
    const title = row.headline ? row.headline.replace(/\s+/g, ' ').trim() : '';
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    const startDate = row.startDate ? row.startDate.slice(0, 10) : null;
    const deadline = row.endDate ? row.endDate.slice(0, 10) : null;
    const pubDate = row.createdAt ? row.createdAt.slice(0, 10) : null;
    const descParts = [row.desc, row.content ? `Exam Month: ${row.content}` : null].filter(Boolean);

    results.push({
      title,
      organization_name: 'Staff Selection Commission (SSC)',
      notification_number: row.examId ? `SSC-CAL-${row.examId}` : null,
      vacancy_count: null,
      job_category: 'SSC Examination Calendar',
      qualification: null,
      state: 'All India',
      application_start_date: startDate,
      application_deadline: deadline,
      exam_date: row.content ? row.content.trim() : null,
      admit_card_date: null,
      result_date: null,
      description: descParts.length > 0 ? descParts.join(' · ') : null,
      pdf_url: null,
      source_url: 'https://ssc.gov.in/',
      published_date: pubDate,
    });
  }

  return results.slice(0, 40);
}

async function checkRobotsAllowed(baseUrl: string): Promise<boolean> {
  try {
    const parsed = new URL(baseUrl);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const resp = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return true;
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    let inStar = false;
    for (const rawLine of lines) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;
      if (/^user-agent:\s*\*/i.test(line)) {
        inStar = true;
      } else if (/^user-agent:/i.test(line)) {
        inStar = false;
      } else if (inStar && /^disallow:\s*\/\s*$/i.test(line)) {
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

async function enrichLiveItems(
  parserKey: string,
  baseUrl: string,
  items: ParsedNotification[]
): Promise<ParsedNotification[]> {
  if (items.length === 0) return items;

  let working = [...items];

  if (parserKey === 'upsc') {
    const batch = working.slice(0, 20);
    const updatedBatch = await mapInBatches(batch, 4, async (item) => {
      if (!item.source_url || item.source_url === baseUrl || !item.source_url.includes('upsc.gov.in/active-examinations/')) {
        return item;
      }
      try {
        const { status, text } = await fetchHtml(item.source_url, 9000);
        if (status === 200 && text) {
          return parseUpscDetailHtml(item, text);
        }
      } catch {
        // Keep listing fields intact
      }
      return item;
    });
    for (let i = 0; i < updatedBatch.length; i += 1) {
      working[i] = updatedBatch[i];
    }
  } else if (parserKey === 'tnpsc') {
    // 1. Fetch TNPSC detail pages (?notid=...) for exact exam dates, application dates, and official PDFs
    const batch = working.slice(0, 20);
    const updatedBatch = await mapInBatches(batch, 4, async (item) => {
      if (!item.source_url || !item.source_url.includes('notid=')) {
        return item;
      }
      try {
        const { status, text } = await fetchHtml(item.source_url, 9000);
        if (status === 200 && text) {
          return parseTnpscDashboardDetailHtml(item, text, item.source_url);
        }
      } catch {
        // Keep base row
      }
      return item;
    });
    for (let i = 0; i < updatedBatch.length; i += 1) {
      working[i] = updatedBatch[i];
    }

    // 2. Fetch TNPSC Annual Planner to backfill exam dates or add scheduled upcoming examinations
    try {
      const plannerUrl = 'https://www.tnpsc.gov.in/DynamicPortals/AnnualPlanner/AnnualPlanner.aspx';
      const { status, text } = await fetchHtml(plannerUrl, 9000);
      if (status === 200 && text) {
        const planned = parseTnpscAnnualPlannerHtml(text, plannerUrl);
        for (const p of planned) {
          const pNorm = p.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          const match = working.find((w) => {
            const wNorm = w.title.toLowerCase().replace(/[^a-z0-9]/g, '');
            return wNorm.includes(pNorm) || pNorm.includes(wNorm);
          });
          if (match) {
            if (!match.exam_date && p.exam_date) match.exam_date = p.exam_date;
          } else {
            working.push(p);
          }
        }
      }
    } catch {
      // Non-fatal
    }
  } else if (parserKey === 'keralapsc') {
    // Expand top 2 latest Gazette subpages into real individual category PDF notifications
    const gazetteUrls = Array.from(
      new Set(
        working
          .map((it) => it.source_url)
          .filter((u) => /extra-ordinary-gazette-date-/i.test(u))
      )
    ).slice(0, 2);

    if (gazetteUrls.length > 0) {
      const gazetteItems: ParsedNotification[] = [];
      const seenCat = new Set<string>();
      await mapInBatches(gazetteUrls, 2, async (gUrl) => {
        try {
          const { status, text } = await fetchHtml(gUrl, 10000);
          if (status === 200 && text) {
            for (const subItem of parseKeralaPscGazetteSubpage(text, gUrl)) {
              const k = (subItem.notification_number || subItem.title).toLowerCase();
              if (!seenCat.has(k)) {
                seenCat.add(k);
                gazetteItems.push(subItem);
              }
            }
          }
        } catch {
          // Non-fatal
        }
      });
      if (gazetteItems.length > 0) {
        working = gazetteItems.slice(0, 30);
      }
    }
  } else if (parserKey === 'rbi') {
    const batch = working.slice(0, 20);
    const updatedBatch = await mapInBatches(batch, 4, async (item) => {
      if (!item.source_url || !item.source_url.includes('bs_viewcontent.aspx')) {
        return item;
      }
      try {
        const { status, text } = await fetchHtml(item.source_url, 9000);
        if (status === 200 && text) {
          return parseRbiDetailHtml(item, text, item.source_url);
        }
      } catch {
        // Keep base row
      }
      return item;
    });
    for (let i = 0; i < updatedBatch.length; i += 1) {
      working[i] = updatedBatch[i];
    }
  } else if (parserKey === 'ibps') {
    const subUrls = Array.from(
      new Set([
        'https://www.ibps.in/index.php/crp-updates',
        'https://www.ibps.in/index.php/recruitment/',
        'https://www.ibps.in/index.php/po-mt-xvi/',
        'https://www.ibps.in/index.php/clerical-cadre-xvi/',
        'https://www.ibps.in/index.php/specialist-officers-xvi/',
        'https://www.ibps.in/index.php/regional-rural-bank-xv/',
        ...working
          .map((it) => it.source_url)
          .filter((u) => u && u !== baseUrl && u.includes('ibps.in/index.php/') && !u.toLowerCase().endsWith('.pdf')),
      ])
    ).slice(0, 10);

    const extraDiscovered: ParsedNotification[] = [];
    await mapInBatches(subUrls, 3, async (subUrl) => {
      try {
        const { status, text } = await fetchHtml(subUrl, 9000);
        if (status === 200 && text) {
          const added = extractIbpsSubpageDates(working, text, subUrl);
          extraDiscovered.push(...added);
        }
      } catch {
        // Non-fatal
      }
    });

    const existingTitles = new Set(working.map((it) => it.title.toLowerCase()));
    for (const item of extraDiscovered) {
      if (!existingTitles.has(item.title.toLowerCase())) {
        existingTitles.add(item.title.toLowerCase());
        working.push(item);
      }
    }
    working = working.slice(0, 30);
  } else if (parserKey === 'nta') {
    const calUrl = 'https://nta.ac.in/Download/Notice/ExamcalendarRevised.pdf';
    try {
      const calBuf = await fetchOfficialPdfBuffer(calUrl, baseUrl, 6_000_000, { timeoutMs: 8000, retries: 0 });
      if (calBuf) {
        const calText = await extractTextFromPdfBuffer(calBuf.buffer);
        const calItems = parseNtaExamCalendarPdfText(calText, calUrl);
        const calMatchers: { test: RegExp; key: string }[] = [
          { test: /ugc[-\s]*net/i, key: 'ugc' },
          { test: /csir/i, key: 'csir' },
          { test: /shreshta/i, key: 'shreshta' },
          { test: /nift/i, key: 'nift' },
          { test: /swayam/i, key: 'swayam' },
          { test: /aissee|sainik/i, key: 'sainik' },
          { test: /cmat/i, key: 'cmat' },
          { test: /cuet\s*\(?pg\)?/i, key: 'cuet' },
          { test: /rimc|rashtriya\s+indian\s+military/i, key: 'rimc' },
          { test: /rashtriya\s+military\s+schools/i, key: 'rms' },
          { test: /army\s+cadets/i, key: 'acc' },
          { test: /jee\s*\(?main\)?/i, key: 'jee' },
        ];
        const calDateByKey = new Map<string, string>();
        for (const ci of calItems) {
          if (!ci.exam_date) continue;
          const m = calMatchers.find((cm) => cm.test.test(ci.title));
          if (m && !calDateByKey.has(m.key)) calDateByKey.set(m.key, ci.exam_date);
        }
        for (const item of working) {
          if (!item.exam_date) {
            const m = calMatchers.find((cm) => cm.test.test(item.title));
            if (m && calDateByKey.has(m.key)) {
              item.exam_date = calDateByKey.get(m.key) || null;
            }
          }
        }
        const existingTitles = new Set(working.map((w) => w.title.toLowerCase()));
        for (const ci of calItems) {
          if (!existingTitles.has(ci.title.toLowerCase())) {
            existingTitles.add(ci.title.toLowerCase());
            working.push(ci);
          }
        }
      }
    } catch {
      // Non-fatal
    }
    working = working.slice(0, 35);
  }

  // Enrich up to 28 PDFs per portal with real unpdf text extraction (batches of 5)
  const pdfTargets = working.slice(0, 28);
  const pdfEnriched = await mapInBatches(pdfTargets, 5, (item) => enrichNotificationFromPdf(item));
  for (let i = 0; i < pdfEnriched.length; i += 1) {
    working[i] = pdfEnriched[i];
  }

  return working;
}

export async function runSourceScrape(
  source: Record<string, unknown>,
  options: {
    triggerType?: string;
    modeOverride?: string | null;
    fixtureOverride?: string | null;
    simulateHttpStatus?: number | null;
    suppressHistory?: boolean;
    replaceDemoWithLive?: boolean;
  } = {}
): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const runId = `RUN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const triggerType = options.triggerType || 'manual';
  const effectiveMode = options.modeOverride || String(source.scrape_mode || 'auto');
  const sourceId = Number(source.id);

  appendMonitoringLog(runId, sourceId, 'INFO', `Starting ${triggerType} check (mode=${effectiveMode}).`);

  if (options.simulateHttpStatus && options.simulateHttpStatus >= 400) {
    return recordFailedScrape(
      source,
      runId,
      triggerType,
      'simulated_error',
      options.simulateHttpStatus,
      `Simulated HTTP ${options.simulateHttpStatus} error from source endpoint.`,
      Date.now() - startMs,
      startedAt
    );
  }

  let htmlContent: string | null = null;
  let httpStatus = 200;
  let isDemoData = true;
  let modeUsed = 'fixture';
  let usedUrl = String(source.base_url);

  if (options.fixtureOverride) {
    const safeName = path.basename(options.fixtureOverride);
    const fixturePath = path.join(FIXTURES_DIR, safeName);
    if (!fs.existsSync(fixturePath)) {
      return recordFailedScrape(
        source,
        runId,
        triggerType,
        'fixture',
        404,
        `Fixture not found: ${safeName}`,
        Date.now() - startMs,
        startedAt
      );
    }
    if (safeName.includes('404')) {
      return recordFailedScrape(
        source,
        runId,
        triggerType,
        'fixture',
        404,
        `HTTP 404 Not Found replayed from ${safeName}`,
        Date.now() - startMs,
        startedAt
      );
    }
    htmlContent = fs.readFileSync(fixturePath, 'utf-8');
    modeUsed = 'fixture';
    isDemoData = true;
    appendMonitoringLog(runId, sourceId, 'INFO', `Loaded offline HTML fixture ${safeName} (DEMO DATA).`);
  } else if (effectiveMode === 'live' || effectiveMode === 'auto') {
    const allowed = await checkRobotsAllowed(String(source.base_url));
    if (!allowed) {
      return recordFailedScrape(
        source,
        runId,
        triggerType,
        'live',
        403,
        'Disallowed by robots.txt policy.',
        Date.now() - startMs,
        startedAt
      );
    }

    const candidateUrls = [String(source.base_url)];
    if (String(source.parser_key) === 'rrbcdg') {
      for (const mirror of RRB_FALLBACK_MIRRORS) {
        if (!candidateUrls.includes(mirror)) candidateUrls.push(mirror);
      }
    }

    let liveError: string | null = null;
    for (let idx = 0; idx < candidateUrls.length; idx += 1) {
      const targetUrl = candidateUrls[idx];
      const perTimeout = String(source.parser_key) === 'rrbcdg' && candidateUrls.length > 1 ? 6000 : 12000;
      try {
        const resp = await fetchHtml(targetUrl, perTimeout);
        httpStatus = resp.status;
        if (httpStatus === 403 || httpStatus === 429) {
          liveError = `HTTP ${httpStatus} received from ${targetUrl}; stopped immediately per respectful crawling policy.`;
          break;
        }
        if (httpStatus >= 500) {
          liveError = `HTTP ${httpStatus} transient server error from ${targetUrl}.`;
          continue;
        }
        if (httpStatus === 200) {
          const text = resp.text;
          const lower = text.slice(0, 4000).toLowerCase();
          if (WAF_MARKERS.some((m) => lower.includes(m))) {
            liveError = `Portal firewall/WAF blocked request on ${targetUrl}; existing data preserved.`;
            httpStatus = 403;
            continue;
          }
          if (CAPTCHA_MARKERS.some((m) => lower.includes(m))) {
            liveError = 'Anti-bot / CAPTCHA challenge detected; never bypassing.';
            httpStatus = 403;
            break;
          }
          htmlContent = text;
          usedUrl = targetUrl;
          modeUsed = 'live';
          isDemoData = false;
          appendMonitoringLog(
            runId,
            sourceId,
            'INFO',
            `Fetched live HTTP 200 response from ${targetUrl} (${text.length} chars).`
          );
          break;
        }
        liveError = `Unexpected HTTP ${httpStatus} from ${targetUrl}.`;
      } catch (err) {
        liveError = `Network error (${targetUrl}): ${err instanceof Error ? err.message.slice(0, 140) : 'Timeout'}`;
      }
    }

    if (!htmlContent) {
      if (effectiveMode === 'live') {
        return recordFailedScrape(
          source,
          runId,
          triggerType,
          'live',
          httpStatus || 503,
          liveError || 'Live fetch failed',
          Date.now() - startMs,
          startedAt
        );
      }
      const fallbackPath = path.join(FIXTURES_DIR, String(source.fixture_filename));
      if (fs.existsSync(fallbackPath)) {
        htmlContent = fs.readFileSync(fallbackPath, 'utf-8');
        modeUsed = 'fixture';
        isDemoData = true;
        httpStatus = 200;
        appendMonitoringLog(
          runId,
          sourceId,
          'WARN',
          `Live request fell back to verified offline fixture (${liveError || 'unavailable'}).`
        );
      } else {
        return recordFailedScrape(
          source,
          runId,
          triggerType,
          'auto',
          httpStatus || 503,
          liveError || 'Fetch and fixture fallback failed',
          Date.now() - startMs,
          startedAt
        );
      }
    }
  } else {
    const fixturePath = path.join(FIXTURES_DIR, String(source.fixture_filename));
    if (!fs.existsSync(fixturePath)) {
      return recordFailedScrape(
        source,
        runId,
        triggerType,
        'fixture',
        404,
        `Missing fixture ${source.fixture_filename}`,
        Date.now() - startMs,
        startedAt
      );
    }
    htmlContent = fs.readFileSync(fixturePath, 'utf-8');
    modeUsed = 'fixture';
    isDemoData = true;
    appendMonitoringLog(runId, sourceId, 'INFO', `Loaded baseline offline fixture ${source.fixture_filename}.`);
  }

  const parserKey = String(source.parser_key);
  const parser = getParser(parserKey);
  let parsedItems =
    modeUsed === 'live' && parserKey === 'ssc'
      ? await fetchSscLiveItems()
      : parser.parse(htmlContent, usedUrl);

  if (modeUsed === 'live' && parsedItems.length === 0 && parserKey === 'ssc') {
    parsedItems = parser.parse(htmlContent, usedUrl);
  }

  if (modeUsed === 'live' && parsedItems.length > 0) {
    parsedItems = await enrichLiveItems(parserKey, usedUrl, parsedItems);
  }

  if (parsedItems.length === 0 && modeUsed === 'live' && effectiveMode === 'auto') {
    const fallbackPath = path.join(FIXTURES_DIR, String(source.fixture_filename));
    if (fs.existsSync(fallbackPath)) {
      htmlContent = fs.readFileSync(fallbackPath, 'utf-8');
      parsedItems = parser.parse(htmlContent, String(source.base_url));
      modeUsed = 'fixture';
      isDemoData = true;
      appendMonitoringLog(
        runId,
        sourceId,
        'WARN',
        'Live page returned 0 structured rows (SPA/JS shell); fell back to verified offline fixture.'
      );
    }
  }

  const durationMs = Date.now() - startMs;
  if (parsedItems.length === 0) {
    return recordFailedScrape(
      source,
      runId,
      triggerType,
      modeUsed,
      httpStatus,
      'Parser returned 0 records (selector/schema mismatch guard). Existing data preserved.',
      durationMs,
      startedAt
    );
  }

  const counts = applyScrapeResults(
    source,
    parsedItems,
    runId,
    isDemoData,
    true,
    2,
    Boolean(options.suppressHistory),
    options.replaceDemoWithLive ?? !isDemoData
  );
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE monitoring_sources SET
      last_attempted_at = ?, last_successful_at = ?, last_http_status = ?,
      last_error = NULL, is_demo_data = ?, freshness_status = 'Healthy',
      last_parsed_count = ?, last_duplicate_count = ?
    WHERE id = ?`
  ).run(
    now,
    now,
    httpStatus,
    isDemoData ? 1 : 0,
    counts.parsed_count,
    counts.duplicate_count,
    sourceId
  );

  db.prepare(
    `INSERT INTO scrape_runs (
      run_id, source_id, trigger_type, mode_used, status, http_status,
      parsed_count, new_count, updated_count, duplicate_count, removed_count,
      error_count, duration_ms, error_message, started_at, completed_at
    ) VALUES (?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`
  ).run(
    runId,
    sourceId,
    triggerType,
    modeUsed,
    httpStatus,
    counts.parsed_count,
    counts.new_count,
    counts.updated_count,
    counts.duplicate_count,
    counts.removed_count,
    durationMs,
    startedAt,
    now
  );

  appendMonitoringLog(
    runId,
    sourceId,
    'INFO',
    `Completed (${modeUsed}): parsed=${counts.parsed_count}, new=${counts.new_count}, updated=${counts.updated_count}, duplicates=${counts.duplicate_count}, removed=${counts.removed_count}.`
  );

  return db.prepare('SELECT * FROM scrape_runs WHERE run_id = ?').get(runId) as Record<string, unknown>;
}
