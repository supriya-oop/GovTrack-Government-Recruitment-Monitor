import * as cheerio from 'cheerio';
import { extractText } from 'unpdf';
import { cleanText, resolveUrl, type ParsedNotification } from './scrapers/base.ts';
import { isPublicHttpUrl, normalizeHumanDate } from './scrapers/index.ts';

export const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'GovTrackMonitor/1.0 (+Academic-Research-Project; respectful-crawler)';

export interface PdfExtractedFields {
  application_start_date: string | null;
  application_deadline: string | null;
  exam_date: string | null;
  admit_card_date: string | null;
  result_date: string | null;
  vacancy_count: string | null;
  qualification: string | null;
  notification_status: string | null;
}

const DATE_TOKEN =
  '(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9},?\\s+\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})';

export async function fetchWithRetry(
  url: string,
  options: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    retries?: number;
  } = {}
): Promise<globalThis.Response> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(encodeURI(decodeURI(url)), {
        headers: {
          'User-Agent': USER_AGENT,
          ...(options.headers || {}),
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Fetch failed');
}

export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
  if (!buffer || buffer.byteLength < 100) return '';
  if (!buffer.subarray(0, 8).toString('latin1').includes('%PDF')) return '';

  const origWarn = console.warn;
  try {
    // Suppress noisy font/cmap warnings from pdfjs during batch PDF extraction
    console.warn = () => {};
    const parsed = await extractText(new Uint8Array(buffer), { mergePages: true });
    const rawText = typeof parsed?.text === 'string' ? parsed.text : '';
    return rawText.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  } finally {
    console.warn = origWarn;
  }
}

export function extractStructuredFieldsFromPdfText(text: string): PdfExtractedFields {
  const result: PdfExtractedFields = {
    application_start_date: null,
    application_deadline: null,
    exam_date: null,
    admit_card_date: null,
    result_date: null,
    vacancy_count: null,
    qualification: null,
    notification_status: null,
  };
  if (!text || text.length < 25) return result;

  if (/\b(?:notification|examination|recruitment)\s+(?:stands\s+)?(?:cancelled|canceled|withdrawn|annulled)\b/i.test(text)) {
    result.notification_status = 'cancelled';
  }

  // Registration date window (start to deadline), including SBI "PAYMENT OF FEES: FROM ..." and NTA "Revised Last Date"
  const regWindowRe = new RegExp(
    `(?:On-?line\\s+Registration(?:\\s+(?:of\\s+Application|including|and|of)\\s+[^.\\n]{0,80})?|Online\\s+submission\\s+of\\s+Application\\s+Form|Registration\\s+(?:Window|Dates?)|Application\\s+(?:opens?|from)|Opening\\s*&\\s*Closing\\s+Date|Submission\\s+of\\s+Online\\s+Application).{0,90}?(?:FROM\\s+)?(${DATE_TOKEN})\\s*(?:to|TO|–|-|&|till|upto)\\s*(${DATE_TOKEN})(?:\\s+(?:FROM\\s+)?(${DATE_TOKEN})\\s*(?:to|TO|–|-|&|till|upto)\\s*(${DATE_TOKEN}))?`,
    'i'
  );
  const regWindow = text.match(regWindowRe);
  if (regWindow) {
    // If two consecutive windows appear (e.g. "Existing: X to Y" followed by "Revised: X to Z"), use the revised later window
    const startRaw = regWindow[3] || regWindow[1];
    const endRaw = regWindow[4] || regWindow[2];
    result.application_start_date = normalizeHumanDate(startRaw);
    result.application_deadline = normalizeHumanDate(endRaw);
  }

  if (!result.application_start_date) {
    const startRe = new RegExp(
      `(?:Date\\s+of\\s+(?:Commencement|Opening)\\s+of\\s+(?:Receiving\\s+)?(?:Online\\s+)?Application|Application\\s+Start\\s+Date|Opening\\s+Date)[^0-9A-Za-z]{0,35}(${DATE_TOKEN})`,
      'i'
    );
    const m = text.match(startRe);
    if (m) result.application_start_date = normalizeHumanDate(m[1]);
  }

  if (!result.application_deadline) {
    const deadlineRe = new RegExp(
      `(?:Last\\s+Date\\s+(?:&\\s+Time\\s+)?(?:for|of)\\s+(?:Receipt\\s+of\\s+|Submission\\s+of\\s+|Online\\s+)?(?:Applications?|Registration)|Closing\\s+Date\\s+(?:for|of)\\s+(?:Application|Registration)|Last\\s+date\\s+for\\s+receipt\\s+of\\s+applications|Last\\s+date\\s+to\\s+apply)[^0-9A-Za-z]{0,40}(${DATE_TOKEN})`,
      'i'
    );
    const deadlineMatch = text.match(deadlineRe);
    if (deadlineMatch) {
      result.application_deadline = normalizeHumanDate(deadlineMatch[1]);
    }
  }

  // Examination dates (prefer exact DD/MM/YYYY or DD Month YYYY dates first)
  const examPatterns = [
    new RegExp(
      `(?:Date\\s+of\\s+(?:Online\\s+)?(?:Preliminary|Mains?|Written|CBT|Competitive|Recruitment)?\\s*Examination|Commencement\\s+of\\s+(?:the\\s+)?Examination|Tentative\\s+Date\\s+of\\s+(?:Online\\s+)?(?:Examination|Test)|Online\\s+Examination\\s*[–:-]?\\s*(?:Preliminary|Phase\\s*-?\\s*I|Tier\\s*-?\\s*I)?|Exam\\s+Date)[^0-9A-Za-z]{0,45}(${DATE_TOKEN})`,
      'i'
    ),
    new RegExp(
      `(?:Preliminary\\s+Examination|Phase\\s*-?\\s*I\\s+(?:Online\\s+)?Exam(?:ination)?|Tier\\s*-?\\s*I\\s+Exam(?:ination)?|Written\\s+Test)[^0-9A-Za-z]{0,45}(${DATE_TOKEN})`,
      'i'
    ),
  ];
  for (const re of examPatterns) {
    const examMatch = text.match(re);
    if (examMatch) {
      const iso = normalizeHumanDate(examMatch[1]);
      if (iso) {
        result.exam_date = iso;
        break;
      }
    }
  }

  // Official Month/Year schedule fallback (e.g. "Online Examination – Preliminary August, 2026")
  if (!result.exam_date) {
    const monthYearRe =
      /(?:Date\s+of\s+(?:Online\s+)?Examination|Online\s+Examination\s*[–:-]\s*(?:Preliminary|Main)|Commencement\s+of\s+Examination)[^0-9A-Za-z]{0,25}((?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s*\/\s*(?:January|February|March|April|May|June|July|August|September|October|November|December))?,?\s+\d{4})/i;
    const myMatch = text.match(monthYearRe);
    if (myMatch) {
      const cleanedMonth = cleanText(myMatch[1]);
      if (cleanedMonth) {
        result.exam_date = cleanedMonth.replace(/,\s*/, ' ');
      }
    }
  }

  const admitRe = new RegExp(
    `(?:Download\\s+of\\s+)?(?:Call\\s+Letters?|Admit\\s+Card|Hall\\s+Ticket|e-Admit\\s+Card)[^0-9A-Za-z]{0,40}(${DATE_TOKEN})`,
    'i'
  );
  const admitMatch = text.match(admitRe);
  if (admitMatch) {
    result.admit_card_date = normalizeHumanDate(admitMatch[1]);
  }

  const resultRe = new RegExp(
    `(?:Declaration|Publication)\\s+of\\s+(?:Preliminary|Main|Final|Written\\s+)?Result[^0-9A-Za-z]{0,40}(${DATE_TOKEN})`,
    'i'
  );
  const resultMatch = text.match(resultRe);
  if (resultMatch) {
    result.result_date = normalizeHumanDate(resultMatch[1]);
  }

  const vacMatch =
    text.match(/\bTotal\s+(?:Tentative\s+|Number\s+of\s+)?Vacancies\s*[:\-–]?\s*(\d{1,6})\b/i) ||
    text.match(/\bNumber\s+of\s+(?:Vacancies|Posts?)\s*[:\-–]?\s*0*(\d{1,6})\b/i) ||
    text.match(/\bVacancies\s*[:\-–]\s*0*(\d{1,6})\b/i);
  if (vacMatch) {
    const num = Number(vacMatch[1]);
    if (num >= 1 && num <= 500000) {
      result.vacancy_count = String(num);
    }
  }

  const headSlice = text.slice(0, 14000);
  const qualPatterns: [RegExp, string][] = [
    [/\b(?:M\.?B\.?B\.?S\.?|Bachelor of Medicine)\b/i, 'MBBS'],
    [/\b(?:B\.E\.?|B\.Tech\.?|B\.?\s*Tech)\b|\b(?:Bachelor of Engineering|Bachelor of Technology)\b/i, 'B.E. / B.Tech'],
    [/\b(?:Post\s+Graduate|Master['’]?s?\s+Degree|M\.?\s*Sc|M\.?\s*A\.?|M\.?\s*Tech|MCA|MBA)\b/i, 'Post Graduate'],
    [/\b(?:Graduation|Graduate|Bachelor['’]?s?\s+Degree|Degree\s+(?:of|from)\s+a\s+recognized\s+University)\b/i, 'Graduate'],
    [/\b(?:Diploma\s+in\s+[A-Za-z ]+|ITI\s+Certificate)\b/i, 'Diploma / ITI'],
    [/\b(?:12th\s+Standard|Higher\s+Secondary|10\+2|Intermediate)\b/i, '12th Pass'],
    [/\b(?:10th\s+Standard|Matriculation|SSLC|Secondary\s+School)\b/i, '10th Pass'],
  ];
  for (const [re, label] of qualPatterns) {
    if (re.test(headSlice)) {
      result.qualification = label;
      break;
    }
  }

  return result;
}

export async function fetchOfficialPdfBuffer(
  pdfUrl: string,
  refererUrl?: string | null,
  maxBytes = 25_000_000,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<{ buffer: Buffer; finalUrl: string } | null> {
  if (!pdfUrl || !isPublicHttpUrl(pdfUrl)) return null;

  const candidates = pdfUrl.startsWith('http://')
    ? [pdfUrl.replace(/^http:\/\//i, 'https://'), pdfUrl]
    : [pdfUrl];

  for (const candidateUrl of candidates) {
    try {
      const pdfOrigin = new URL(candidateUrl).origin;
      const refOrigin = refererUrl && isPublicHttpUrl(refererUrl) ? new URL(refererUrl).origin : null;
      const originReferer = refOrigin === pdfOrigin ? refererUrl! : `${pdfOrigin}/`;

      let resp = await fetchWithRetry(candidateUrl, {
        timeoutMs: options.timeoutMs ?? 12000,
        retries: options.retries ?? 1,
        headers: {
          Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
          Referer: originReferer,
        },
      });

      if (resp.status === 403 || resp.status === 401) {
        resp = await fetchWithRetry(candidateUrl, {
          timeoutMs: options.timeoutMs ?? 10000,
          retries: 0,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            Accept: '*/*',
          },
        });
      }
      if (!resp.ok) continue;

      const lenHeader = Number(resp.headers.get('content-length') || '0');
      if (lenHeader > maxBytes) continue;

      const arrBuf = await resp.arrayBuffer();
      if (arrBuf.byteLength < 100 || arrBuf.byteLength > maxBytes) continue;

      const buf = Buffer.from(arrBuf);
      const isPdfMagic = buf.subarray(0, 16).toString('latin1').includes('%PDF');
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (!isPdfMagic && !ct.includes('application/pdf')) continue;

      return { buffer: buf, finalUrl: resp.url || candidateUrl };
    } catch {
      // Try next URL candidate
    }
  }

  return null;
}

export async function discoverPdfUrlFromHtmlPage(
  pageUrl: string,
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<string | null> {
  if (!pageUrl || !isPublicHttpUrl(pageUrl)) return null;
  if (/\.pdf(?:$|\?)/i.test(pageUrl)) return pageUrl;

  try {
    const resp = await fetchWithRetry(pageUrl, {
      timeoutMs: options.timeoutMs ?? 8000,
      retries: options.retries ?? 1,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${new URL(pageUrl).origin}/`,
      },
    });
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/pdf')) return resp.url || pageUrl;

    const html = await resp.text();
    const $ = cheerio.load(html);
    const candidates: string[] = [];

    $('a[href*=".pdf"], a[href*=".PDF"]').each((_, el) => {
      const resolved = resolveUrl(pageUrl, $(el).attr('href'));
      if (resolved && isPublicHttpUrl(resolved) && !/Annual_Recruitment_Calendar|Utkarsh2029|authorised-signatory/i.test(resolved)) {
        candidates.push(resolved);
      }
    });

    // Also inspect embedded absolute or relative .pdf strings in script/SSR markup (e.g. UPSC Next.js payloads)
    const regexMatches = html.match(/(?:https?:\/\/[^"'\s\\<>]+|\/(?:uploads|Document|document|Notifications1|sites\/default\/files)\/[^"'\s\\<>]+)\.pdf/gi) || [];
    for (const m of regexMatches) {
      const resolved = resolveUrl(pageUrl, m);
      if (resolved && isPublicHttpUrl(resolved) && !candidates.includes(resolved)) {
        candidates.push(resolved);
      }
    }

    if (candidates.length === 0) return null;

    return (
      candidates.find((u) => /notif/i.test(u) && /engl/i.test(u)) ||
      candidates.find((u) => /notif|advt|detailed/i.test(u)) ||
      candidates.find((u) => /engl/i.test(u)) ||
      candidates[0]
    );
  } catch {
    return null;
  }
}

export async function enrichNotificationFromPdf(item: ParsedNotification): Promise<ParsedNotification> {
  if (!item.pdf_url || !isPublicHttpUrl(item.pdf_url)) {
    return item;
  }
  const missingImportant =
    !item.exam_date || !item.application_deadline || !item.application_start_date || !item.vacancy_count || !item.qualification;
  if (!missingImportant) {
    return item;
  }

  try {
    const fetched = await fetchOfficialPdfBuffer(item.pdf_url, item.source_url, 6_000_000);
    if (!fetched) return item;

    const pdfText = await extractTextFromPdfBuffer(fetched.buffer);
    if (!pdfText) return item;

    const extracted = extractStructuredFieldsFromPdfText(pdfText);
    const next: ParsedNotification = { ...item };
    if (!next.application_start_date && extracted.application_start_date) {
      next.application_start_date = extracted.application_start_date;
    }
    if (!next.application_deadline && extracted.application_deadline) {
      next.application_deadline = extracted.application_deadline;
    }
    if (!next.exam_date && extracted.exam_date) {
      next.exam_date = extracted.exam_date;
    }
    if (!next.admit_card_date && extracted.admit_card_date) {
      next.admit_card_date = extracted.admit_card_date;
    }
    if (!next.result_date && extracted.result_date) {
      next.result_date = extracted.result_date;
    }
    if (!next.vacancy_count && extracted.vacancy_count) {
      next.vacancy_count = extracted.vacancy_count;
    }
    if (!next.qualification && extracted.qualification) {
      next.qualification = extracted.qualification;
    }
    if (extracted.notification_status === 'cancelled') {
      next.notification_status = 'cancelled';
    }
    if (!next.description && extracted.exam_date) {
      next.description = cleanText(`Exam Date: ${extracted.exam_date}`);
    }
    return next;
  } catch {
    return item;
  }
}
