import * as cheerio from 'cheerio';
import { cleanText, resolveUrl, type ParsedNotification, type PortalParser } from './base.ts';

const MONTHS: Record<string, string> = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

export function normalizeHumanDate(raw?: string | null): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned || /^(-+|—+|n\/?a|nil|tba|not\s+applicable)$/i.test(cleaned)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  const compact = cleaned.match(/(?:^|_)(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\d{6})?(?:\.pdf|$)/i);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  const dmy = cleaned.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const mon = Number(dmy[2]);
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      return `${dmy[3]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const dMonY = cleaned.match(/(\d{1,2})(?:st|nd|rd|th)?[-/\s]+([A-Za-z]{3,9}),?[-/\s]+(\d{4})/);
  if (dMonY) {
    const mon = MONTHS[dMonY[2].toLowerCase()] || MONTHS[dMonY[2].slice(0, 3).toLowerCase()];
    if (mon) {
      return `${dMonY[3]}-${mon}-${dMonY[1].padStart(2, '0')}`;
    }
  }

  const monDY = cleaned.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\b/);
  if (monDY) {
    const mon = MONTHS[monDY[1].toLowerCase()] || MONTHS[monDY[1].slice(0, 3).toLowerCase()];
    if (mon) {
      return `${monDY[3]}-${mon}-${monDY[2].padStart(2, '0')}`;
    }
  }

  return null;
}

export function normalizeUsDate(raw?: string | null): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned) return null;
  const mdy = cleaned.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (mdy) {
    const mon = Number(mdy[1]);
    const day = Number(mdy[2]);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${mdy[3]}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return normalizeHumanDate(raw);
}

export function isPublicHttpUrl(url: string | null): boolean {
  if (!url) return false;
  return /^https?:\/\/(?!10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
}

export function parseUpscDetailHtml(item: ParsedNotification, html: string): ParsedNotification {
  const $ = cheerio.load(html);
  const next: ParsedNotification = { ...item };
  const details: string[] = [];

  if (!next.notification_number) {
    const bodyText = $('body').text();
    const noticeMatch = bodyText.match(/Examination Notice No:\s*([A-Z0-9/()-]+)/i);
    if (noticeMatch && noticeMatch[1] !== '—') {
      next.notification_number = cleanText(noticeMatch[1]);
    }
  }

  $('.exam-detail-card .col-lg, .exam-detail-card > div').each((_, col) => {
    const children = $(col).children();
    if (children.length < 2) return;
    const label = cleanText(children.eq(0).text()) || '';
    const value = cleanText(children.eq(1).text()) || '';
    if (!label || !value) return;

    if (/date of notification/i.test(label)) {
      const iso = normalizeHumanDate(value);
      if (iso) {
        next.published_date = iso;
        if (!next.application_start_date) {
          next.application_start_date = iso;
        }
      }
    } else if (/date of upload/i.test(label) && !next.published_date) {
      const iso = normalizeHumanDate(value);
      if (iso) next.published_date = iso;
    } else if (/commencement of examination/i.test(label)) {
      const iso = normalizeHumanDate(value);
      if (iso) next.exam_date = iso;
    } else if (/last date for submission/i.test(label)) {
      const iso = normalizeHumanDate(value);
      next.application_deadline = iso;
      if (!iso) {
        next.application_start_date = null;
      }
    } else if (/duration of examination/i.test(label)) {
      details.push(`Duration: ${value}`);
    }
  });

  const docLabels: string[] = [];
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const docType = cleanText($(tds[0]).text()) || '';
    const uploadDate = normalizeHumanDate($(tds[1]).text());
    if (!docType || /document type/i.test(docType)) return;
    docLabels.push(docType.replace(/keyboard_arrow_down/gi, '').trim());

    if (/admit\s*card/i.test(docType) && uploadDate) {
      next.admit_card_date = uploadDate;
    } else if (/(?:written|final|recommended).*result|^\s*result/i.test(docType) && uploadDate) {
      next.result_date = uploadDate;
    }
  });

  const baseForResolve = next.source_url || 'https://upsc.gov.in/active-examinations/';
  const pdfSet = new Set<string>();
  $('a[href*=".pdf"], a[href*=".PDF"]').each((_, a) => {
    const resolved = resolveUrl(baseForResolve, $(a).attr('href'));
    if (resolved && isPublicHttpUrl(resolved)) pdfSet.add(resolved);
  });
  const embeddedPdfs =
    html.match(/(?:https?:\/\/(?:www\.)?upsc\.gov\.in)?\/(?:uploads|sites\/default\/files)\/[^"'\s\\<>]+\.pdf/gi) || [];
  for (const rawPdf of embeddedPdfs) {
    const resolved = resolveUrl(baseForResolve, rawPdf);
    if (resolved && isPublicHttpUrl(resolved)) pdfSet.add(resolved);
  }

  const pdfMatches = Array.from(pdfSet);
  if (pdfMatches.length > 0) {
    const englishNotif =
      pdfMatches.find((u) => /notif/i.test(u) && /engl/i.test(u)) ||
      pdfMatches.find((u) => /notif/i.test(u) && !/hindi/i.test(u)) ||
      pdfMatches.find((u) => /engl/i.test(u)) ||
      pdfMatches.find((u) => !/hindi/i.test(u)) ||
      pdfMatches[0];
    next.pdf_url = englishNotif;
  }

  const factParts: string[] = [];
  if (next.notification_number) factParts.push(`Notice No: ${next.notification_number}`);
  factParts.push(...details);
  if (docLabels.length > 0) factParts.push(`Documents: ${docLabels.slice(0, 5).join(', ')}`);
  if (factParts.length > 0) {
    next.description = factParts.join(' · ');
  }
  return next;
}

export function parseTnpscDashboardDetailHtml(
  item: ParsedNotification,
  html: string,
  detailUrl: string
): ParsedNotification {
  const $ = cheerio.load(html);
  const next: ParsedNotification = { ...item };
  const notes: string[] = [];
  const pdfCandidates: string[] = [];

  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const category = cleanText($(tds[0]).text()) || '';
    const titleCell = cleanText($(tds[1]).text()) || '';
    const linkHref = resolveUrl(detailUrl, $(tr).find('a').first().attr('href'));
    const uploadDate = tds.length >= 4 ? normalizeHumanDate($(tds[3]).text()) : null;

    if (/^notification$/i.test(category)) {
      if (uploadDate && !next.published_date) next.published_date = uploadDate;
      if (linkHref && /\.pdf/i.test(linkHref) && isPublicHttpUrl(linkHref)) {
        pdfCandidates.unshift(linkHref);
      }
    } else if (/date\s+of\s+examination/i.test(category) || /date\s+of\s+examination/i.test(titleCell)) {
      const examIso = normalizeHumanDate(titleCell);
      if (examIso) next.exam_date = examIso;
    } else if (/apply\s+online/i.test(category)) {
      const startM = titleCell.match(/(?:commencement|opening)\s+of\s+(?:receiving\s+)?application\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
      const endM = titleCell.match(/last\s+date[^:]*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
      if (startM) next.application_start_date = normalizeHumanDate(startM[1]);
      if (endM) next.application_deadline = normalizeHumanDate(endM[1]);
      if (!next.published_date && uploadDate) next.published_date = uploadDate;
    } else if (/hall\s*ticket|admit\s*card/i.test(category) && uploadDate) {
      next.admit_card_date = uploadDate;
    } else if (/result|selection\s*list|counselling/i.test(category) && uploadDate && !next.result_date) {
      next.result_date = uploadDate;
    } else if (/addendum|amendment|corrigendum/i.test(category)) {
      notes.push(titleCell);
      if (linkHref && /\.pdf/i.test(linkHref) && isPublicHttpUrl(linkHref)) {
        pdfCandidates.push(linkHref);
      }
    }
  });

  if (pdfCandidates.length > 0 && !next.pdf_url) {
    next.pdf_url = pdfCandidates[0];
  }
  if (notes.length > 0) {
    next.description = `${next.description ? `${next.description} · ` : ''}${notes.slice(0, 2).join('; ')}`;
  }
  return next;
}

export function parseTnpscAnnualPlannerHtml(html: string, plannerUrl: string): ParsedNotification[] {
  const $ = cheerio.load(html);
  const results: ParsedNotification[] = [];
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return;
    const sno = cleanText($(tds[0]).text());
    const name = cleanText($(tds[1]).text());
    if (!sno || !/^\d+$/.test(sno) || !name || name.length < 10) return;
    const notifDate = normalizeHumanDate($(tds[2]).text());
    const examDate = normalizeHumanDate($(tds[3]).text());
    const days = tds.length >= 5 ? cleanText($(tds[4]).text()) : null;

    results.push({
      title: name,
      organization_name: 'Tamil Nadu Public Service Commission (TNPSC)',
      notification_number: `TNPSC-PLAN-2026-${sno}`,
      vacancy_count: null,
      job_category: 'TNPSC Annual Planner',
      qualification: null,
      state: 'Tamil Nadu',
      application_start_date: notifDate,
      application_deadline: null,
      exam_date: examDate,
      admit_card_date: null,
      result_date: null,
      description: days ? `TNPSC Annual Planner 2026 · Notification date: ${notifDate || 'TBA'} · Duration: ${days} day(s)` : 'TNPSC Annual Planner 2026',
      pdf_url: null,
      source_url: plannerUrl,
      published_date: notifDate,
    });
  });
  return results;
}

export function parseKeralaPscGazetteSubpage(html: string, subpageUrl: string): ParsedNotification[] {
  const $ = cheerio.load(html);
  const results: ParsedNotification[] = [];
  const seen = new Set<string>();

  const dateSlugMatch = subpageUrl.match(/gazette-date-(\d{2})(\d{2})(\d{4})/i);
  const gazettePubDate = dateSlugMatch ? `${dateSlugMatch[3]}-${dateSlugMatch[2]}-${dateSlugMatch[1]}` : null;

  $('a[href*=".pdf"], a[href*=".PDF"]').each((_, el) => {
    const href = resolveUrl(subpageUrl, $(el).attr('href'));
    const title = cleanText($(el).text());
    if (!href || !title || title.length < 12 || !isPublicHttpUrl(href)) return;
    if (/authorised[- ]signatory|inline-files/i.test(href + title)) return;

    const catMatch = title.match(/\b(\d{1,3}\/\d{4})\b/)?.[1] || null;
    const dedupeKey = catMatch || title.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const state = 'Kerala';
    results.push({
      title: title.replace(/\(\s*Cat\.?\s*No\.?\s*[^)]+\)/i, '').trim() || title,
      organization_name: 'Kerala Public Service Commission (Kerala PSC)',
      notification_number: catMatch ? `Cat. No. ${catMatch}` : null,
      vacancy_count: null,
      job_category: 'State Civil Services',
      qualification: null,
      state,
      application_start_date: gazettePubDate,
      application_deadline: null,
      exam_date: null,
      admit_card_date: null,
      result_date: null,
      description: gazettePubDate ? `Kerala PSC Extraordinary Gazette Notification dated ${gazettePubDate}` : 'Kerala PSC Extraordinary Gazette Notification',
      pdf_url: href,
      source_url: subpageUrl,
      published_date: gazettePubDate,
    });
  });

  return results;
}

export function parseRbiDetailHtml(item: ParsedNotification, html: string, detailUrl: string): ParsedNotification {
  const $ = cheerio.load(html);
  const next: ParsedNotification = { ...item };
  const container = $('#pnlContent, .tablebg, main, body').first();
  const txt = cleanText(container.text()) || '';

  const pubMatch = txt.match(/Date\s*:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
  if (pubMatch) {
    next.published_date = normalizeHumanDate(pubMatch[1]);
  }

  const lastDateMatch = txt.match(
    /(?:last\s+date[^.]{0,80}?|on\s+or\s+before|reach[^.]{0,40}?by|closing\s+date[^.]{0,40}?)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4}|[A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4})/i
  );
  if (lastDateMatch) {
    next.application_deadline = normalizeHumanDate(lastDateMatch[1]);
  }

  const examMatch = txt.match(
    /(?:Date\s+of\s+(?:Online\s+)?Examination|Tentative\s+Date\s+of\s+(?:Test|Exam(?:ination)?)|Phase[- ]?I\s+Exam)[^.]{0,40}?(\d{1,2}[./-]\d{1,2}[./-]\d{4}|[A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4})/i
  );
  if (examMatch) {
    next.exam_date = normalizeHumanDate(examMatch[1]);
  }

  const vacMatch =
    txt.match(/\b(?:fill|total|engage)\s+(?:[a-z]+\s+)?\((\d{1,4})\)\s*(?:posts?|vacanc(?:y|ies))/i) ||
    txt.match(/\b(\d{1,4})\s+(?:posts?|vacanc(?:y|ies))\b/i);
  if (vacMatch) {
    next.vacancy_count = vacMatch[1];
  }

  const pdfLinks: string[] = [];
  $('a[href*=".pdf"], a[href*=".PDF"]').each((_, a) => {
    const resolved = resolveUrl(detailUrl, $(a).attr('href'));
    if (
      resolved &&
      isPublicHttpUrl(resolved) &&
      !/Annual_Recruitment_Calendar|Utkarsh2029/i.test(resolved)
    ) {
      pdfLinks.push(resolved);
    }
  });
  if (pdfLinks.length > 0) {
    next.pdf_url = pdfLinks[0];
  }

  const para = cleanText($('#pnlContent p, .tablebg p').first().text());
  if (para && para.length > 30) {
    next.description = para.slice(0, 260);
  }
  return next;
}

export function extractIbpsSubpageDates(items: ParsedNotification[], html: string, pageUrl: string): ParsedNotification[] {
  const $ = cheerio.load(html);
  const entries: { date: string | null; title: string; pdfUrl: string | null }[] = [];

  $('a').each((_, a) => {
    const href = resolveUrl(pageUrl, $(a).attr('href'));
    const text = cleanText($(a).text());
    if (!href || !text || text.length < 15) return;
    if (!/\.pdf$/i.test(href) && !/notification|result|allotment|call\s*letter|score|corrigendum/i.test(text)) return;

    const parentText = cleanText($(a).closest('li, tr, p, div').text()) || text;
    const dateMatch = parentText.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})/);
    const pubDate = dateMatch ? normalizeHumanDate(dateMatch[1]) : null;
    entries.push({
      date: pubDate,
      title: text,
      pdfUrl: /\.pdf$/i.test(href) && isPublicHttpUrl(href) ? href : null,
    });
  });

  if (entries.length === 0) return [];

  for (const item of items) {
    const titleLower = item.title.toLowerCase();
    const match =
      entries.find((e) => e.title.toLowerCase() === titleLower) ||
      entries.find(
        (e) =>
          (item.notification_number &&
            e.title.toLowerCase().includes(item.notification_number.toLowerCase())) ||
          (/notification/i.test(e.title) && item.source_url === pageUrl)
      ) ||
      entries.find((e) => item.source_url === pageUrl && e.pdfUrl);

    if (match) {
      if (!item.published_date && match.date) item.published_date = match.date;
      if (!item.pdf_url && match.pdfUrl) item.pdf_url = match.pdfUrl;
      if (/result|provisional\s+allotment|score/i.test(item.title) && match.date) {
        item.result_date = match.date;
      }
      if (/call\s*letter|admit\s*card/i.test(item.title) && match.date) {
        item.admit_card_date = match.date;
      }
    }
  }

  // Also return newly discovered CRP PDF notices from listing subpages like /crp-updates
  const discovered: ParsedNotification[] = [];
  for (const e of entries) {
    if (!e.pdfUrl) continue;
    const crpMatch = e.title.match(/CRP[-\sA-Z/]+(?:XVII|XVI|XV|XIV)/i)?.[0] || null;
    discovered.push({
      title: e.title,
      organization_name: 'Institute of Banking Personnel Selection (IBPS)',
      notification_number: crpMatch,
      vacancy_count: null,
      job_category: 'Public Sector Banking',
      qualification: 'Graduate',
      state: 'All India',
      application_start_date: null,
      application_deadline: null,
      exam_date: null,
      admit_card_date: /call\s*letter|admit\s*card/i.test(e.title) ? e.date : null,
      result_date: /result|allotment|score/i.test(e.title) ? e.date : null,
      description: e.date ? `Official IBPS notice dated ${e.date}` : null,
      pdf_url: e.pdfUrl,
      source_url: pageUrl,
      published_date: e.date,
    });
  }
  return discovered;
}

const upscParser: PortalParser = {
  parserKey: 'upsc',
  parse(html, sourceUrl = 'https://upsc.gov.in/active-examinations/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];

    const fixtureRows = $('table.upsc-notice-table tbody tr.upsc-row');
    if (fixtureRows.length > 0) {
      fixtureRows.each((_, el) => {
        const row = $(el);
        const titleEl = row.find('td.col-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'Union Public Service Commission (UPSC)',
          notification_number: cleanText(row.find('td.col-advt').text()),
          vacancy_count: cleanText(row.find('td.col-vacancy').text()),
          job_category: cleanText(row.attr('data-category')) || 'Central Civil Services',
          qualification: cleanText(row.attr('data-qualification')),
          state: cleanText(row.attr('data-state')) || 'All India',
          application_start_date: cleanText(row.find('td.col-start').text()),
          application_deadline: cleanText(row.find('td.col-deadline').text()),
          exam_date: cleanText(row.find('td.col-exam').text()),
          admit_card_date: cleanText(row.find('td.col-admit').text()),
          result_date: cleanText(row.find('td.col-result').text()),
          description: cleanText(row.find('td.col-title p.summary').text()),
          pdf_url: resolveUrl(sourceUrl, row.find('td.col-pdf a').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(row.find('td.col-published').text()),
        });
      });
      return results;
    }

    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const anchor = $(tds[0]).find('a').first();
      const title = cleanText(anchor.text() || $(tds[0]).text());
      if (!title || /examination name/i.test(title)) return;
      const noticeNo = cleanText($(tds[1]).text());
      const examDate = normalizeHumanDate($(tds[2]).text());
      const deadline = tds.length >= 4 ? normalizeHumanDate($(tds[3]).text()) : null;
      const href = resolveUrl(sourceUrl, anchor.attr('href')) || sourceUrl;
      results.push({
        title,
        organization_name: 'Union Public Service Commission (UPSC)',
        notification_number: noticeNo && noticeNo !== '—' ? noticeNo : null,
        vacancy_count: null,
        job_category: 'UPSC Active Examination',
        qualification: null,
        state: 'All India',
        application_start_date: null,
        application_deadline: deadline,
        exam_date: examDate,
        admit_card_date: null,
        result_date: null,
        description: noticeNo && noticeNo !== '—' ? `Examination Notice No: ${noticeNo}` : null,
        pdf_url: href.toLowerCase().endsWith('.pdf') ? href : null,
        source_url: href,
        published_date: null,
      });
    });
    return results.slice(0, 35);
  },
};

const sscParser: PortalParser = {
  parserKey: 'ssc',
  parse(html, sourceUrl = 'https://ssc.gov.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const cards = $('section.ssc-notice-board article.notice-board-card');
    if (cards.length > 0) {
      cards.each((_, el) => {
        const card = $(el);
        const titleEl = card.find('.notice-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'Staff Selection Commission (SSC)',
          notification_number: cleanText(card.find('.notice-num').text()),
          vacancy_count: cleanText(card.find('.vacancies').text()),
          job_category: cleanText(card.attr('data-category')) || 'Central Group B & C',
          qualification: cleanText(card.attr('data-qualification')),
          state: cleanText(card.attr('data-state')) || 'All India',
          application_start_date: cleanText(card.find('.start-date').text()),
          application_deadline: cleanText(card.find('.deadline').text()),
          exam_date: cleanText(card.find('.exam-date').text()),
          admit_card_date: cleanText(card.find('.admit-date').text()),
          result_date: cleanText(card.find('.result-date').text()),
          description: cleanText(card.find('.notice-desc').text()),
          pdf_url: resolveUrl(sourceUrl, card.find('a.pdf-link').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(card.find('.published-date').text()),
        });
      });
      return results;
    }

    $('a[href*=".pdf"], .latest-news-list a, .notice-board a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (title && href && title.length > 18) {
        const parentText = cleanText($(el).closest('li, tr, div').text()) || '';
        const dateMatch = parentText.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);
        results.push({
          title,
          organization_name: 'Staff Selection Commission (SSC)',
          notification_number: null,
          vacancy_count: null,
          job_category: 'SSC Notice',
          qualification: null,
          state: 'All India',
          application_start_date: null,
          application_deadline: null,
          exam_date: null,
          admit_card_date: null,
          result_date: null,
          description: null,
          pdf_url: href.toLowerCase().includes('.pdf') && isPublicHttpUrl(href) ? href : null,
          source_url: href,
          published_date: dateMatch ? normalizeHumanDate(dateMatch[1]) : null,
        });
      }
    });
    return results.slice(0, 35);
  },
};

const tnpscParser: PortalParser = {
  parserKey: 'tnpsc',
  parse(html, sourceUrl = 'https://tnpsc.gov.in/web/examdashboard/index.aspx') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];

    const fixtureRows = $('table#notification-grid tbody tr.tnpsc-item');
    if (fixtureRows.length > 0) {
      fixtureRows.each((_, el) => {
        const row = $(el);
        const titleEl = row.find('td.post-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'Tamil Nadu Public Service Commission (TNPSC)',
          notification_number: cleanText(row.find('td.advt-no').text()),
          vacancy_count: cleanText(row.find('td.vacancies').text()),
          job_category: cleanText(row.find('td.category').text()) || 'State Civil Services',
          qualification: cleanText(row.attr('data-qualification')),
          state: cleanText(row.attr('data-state')) || 'Tamil Nadu',
          application_start_date: cleanText(row.find('td.start').text()),
          application_deadline: cleanText(row.find('td.deadline').text()),
          exam_date: cleanText(row.find('td.exam').text()),
          admit_card_date: cleanText(row.find('td.admit').text()),
          result_date: cleanText(row.find('td.result').text()),
          description: cleanText(row.find('td.desc').text()),
          pdf_url: resolveUrl(sourceUrl, row.find('td.pdf a').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(row.find('td.published').text()),
        });
      });
      return results;
    }

    // Live TNPSC Exam Dashboard (2026 & current recruitments with ?notid=...)
    const seen = new Set<string>();
    $('a[href*="notid="]').each((_, a) => {
      const rawText = cleanText($(a).text());
      const href = resolveUrl(sourceUrl, $(a).attr('href'));
      if (!rawText || !href || !isPublicHttpUrl(href) || seen.has(href)) return;
      seen.add(href);

      const notifNoMatch = rawText.match(/\b(\d{1,3}\/\d{4})\b/);
      const notifNo = notifNoMatch ? notifNoMatch[1] : null;
      const cleanedTitle = rawText
        .replace(/^\d+\.\s*/, '')
        .replace(/\s*[-–]\s*\d{1,3}\/\d{4}\s*$/, '')
        .trim();

      results.push({
        title: cleanedTitle || rawText,
        organization_name: 'Tamil Nadu Public Service Commission (TNPSC)',
        notification_number: notifNo,
        vacancy_count: null,
        job_category: 'State Civil Services',
        qualification: null,
        state: 'Tamil Nadu',
        application_start_date: null,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: notifNo ? `TNPSC Exam Dashboard Notification ${notifNo}` : 'TNPSC Exam Dashboard Notification',
        pdf_url: null,
        source_url: href,
        published_date: null,
      });
    });

    if (results.length > 0) {
      return results.slice(0, 30);
    }

    // Fallback: legacy Notification.aspx table
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 5) return;
      const notifNo = cleanText($(tds[1]).text());
      if (!notifNo || !/\d{1,3}\/\d{4}/.test(notifNo)) return;

      const postTd = $(tds[2]);
      const pdfAnchor = postTd
        .find('a[href*=".pdf"]')
        .filter((__, a) => !/addendum/i.test($(a).text()))
        .first();
      const title =
        cleanText(pdfAnchor.text()) ||
        cleanText(
          postTd
            .clone()
            .find('a')
            .filter((__, a) => /apply online|hall ticket|addendum/i.test($(a).text()))
            .remove()
            .end()
            .text()
        );
      if (!title) return;

      const pdfUrl = resolveUrl(sourceUrl, pdfAnchor.attr('href'));
      const startDate = normalizeHumanDate($(tds[3]).text());
      const deadline = normalizeHumanDate($(tds[4]).text());
      const rawExamText = tds.length >= 6 ? cleanText($(tds[5]).text()) : null;
      const examDate = normalizeHumanDate(rawExamText);

      const descParts = [`TNPSC Notification ${notifNo}`];
      if (rawExamText) descParts.push(`Exam Schedule: ${rawExamText}`);
      const hasHallTicket = postTd
        .find('a')
        .toArray()
        .some((a) => /hall ticket/i.test($(a).text()) && !/display:\s*none/i.test($(a).attr('style') || ''));
      if (hasHallTicket) descParts.push('Hall Ticket download link active on portal');

      results.push({
        title,
        organization_name: 'Tamil Nadu Public Service Commission (TNPSC)',
        notification_number: notifNo,
        vacancy_count: null,
        job_category: 'State Civil Services',
        qualification: null,
        state: 'Tamil Nadu',
        application_start_date: startDate,
        application_deadline: deadline,
        exam_date: examDate,
        admit_card_date: null,
        result_date: null,
        description: descParts.join(' · '),
        pdf_url: isPublicHttpUrl(pdfUrl) ? pdfUrl : null,
        source_url: sourceUrl,
        published_date: startDate,
      });
    });
    return results.slice(0, 25);
  },
};

const keralaPscParser: PortalParser = {
  parserKey: 'keralapsc',
  parse(html, sourceUrl = 'https://www.keralapsc.gov.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const cards = $('.kpsc-notifications .kpsc-card');
    if (cards.length > 0) {
      cards.each((_, el) => {
        const card = $(el);
        const titleEl = card.find('.kpsc-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        const meta: Record<string, string | null> = {};
        card.find('.kpsc-meta span[data-k]').each((__, sp) => {
          const k = $(sp).attr('data-k');
          if (k) meta[k] = cleanText($(sp).text());
        });
        results.push({
          title,
          organization_name: 'Kerala Public Service Commission (Kerala PSC)',
          notification_number: cleanText(card.find('.kpsc-cat-no').text()),
          vacancy_count: meta.vacancies ?? null,
          job_category: cleanText(card.attr('data-category')) || 'State Civil Services',
          qualification: cleanText(card.attr('data-qualification')),
          state: cleanText(card.attr('data-state')) || 'Kerala',
          application_start_date: meta.start ?? null,
          application_deadline: meta.deadline ?? null,
          exam_date: meta.exam ?? null,
          admit_card_date: meta.admit ?? null,
          result_date: meta.result ?? null,
          description: cleanText(card.find('.kpsc-desc').text()),
          pdf_url: resolveUrl(sourceUrl, card.find('a.kpsc-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: meta.published ?? null,
        });
      });
      return results;
    }

    const seen = new Set<string>();
    $('a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (!title || !href || !isPublicHttpUrl(href) || title.length < 18) return;
      if (!/notification|category|ranked list|shortlist|gazette|extra-ordinary-gazette/i.test(title + href)) return;
      const dedupeKey = href.toLowerCase();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const catMatch = title.match(/\b\d{1,3}\/\d{4}\b/)?.[0] || null;
      const dateSlugMatch = href.match(/gazette-date-(\d{2})(\d{2})(\d{4})/i);
      const gazettePub = dateSlugMatch ? `${dateSlugMatch[3]}-${dateSlugMatch[2]}-${dateSlugMatch[1]}` : null;

      results.push({
        title,
        organization_name: 'Kerala Public Service Commission (Kerala PSC)',
        notification_number: catMatch ? `Cat. No. ${catMatch}` : null,
        vacancy_count: null,
        job_category: 'State Civil Services',
        qualification: null,
        state: 'Kerala',
        application_start_date: gazettePub,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: gazettePub ? `Kerala PSC Extraordinary Gazette dated ${gazettePub}` : null,
        pdf_url: href.toLowerCase().includes('.pdf') && isPublicHttpUrl(href) ? href : null,
        source_url: href,
        published_date: gazettePub,
      });
    });
    return results.slice(0, 25);
  },
};

const rpscParser: PortalParser = {
  parserKey: 'rpsc',
  parse(html, sourceUrl = 'https://rpsc.rajasthan.gov.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const rows = $('table.rpsc-advt-table tbody tr.rpsc-row');
    if (rows.length > 0) {
      rows.each((_, el) => {
        const row = $(el);
        const titleEl = row.find('td.rpsc-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'Rajasthan Public Service Commission (RPSC)',
          notification_number: cleanText(row.find('td.rpsc-advt').text()),
          vacancy_count: cleanText(row.find('td.rpsc-vac').text()),
          job_category: cleanText(row.attr('data-category')) || 'State Civil Services',
          qualification: cleanText(row.attr('data-qualification')),
          state: cleanText(row.attr('data-state')) || 'Rajasthan',
          application_start_date: cleanText(row.find('td.rpsc-start').text()),
          application_deadline: cleanText(row.find('td.rpsc-deadline').text()),
          exam_date: cleanText(row.find('td.rpsc-exam').text()),
          admit_card_date: cleanText(row.find('td.rpsc-admit').text()),
          result_date: cleanText(row.find('td.rpsc-result').text()),
          description: cleanText(row.find('td.rpsc-desc').text()),
          pdf_url: resolveUrl(sourceUrl, row.find('a.rpsc-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(row.find('td.rpsc-pub').text()),
        });
      });
      return results;
    }

    $('a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (title && href && title.length > 18 && /advt|advertisement|ras|exam|corrigendum|press note/i.test(title)) {
        const parentText = cleanText($(el).closest('li, tr, div').text()) || '';
        const dateMatch = parentText.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4})/);
        results.push({
          title,
          organization_name: 'Rajasthan Public Service Commission (RPSC)',
          notification_number: null,
          vacancy_count: null,
          job_category: 'State Civil Services',
          qualification: null,
          state: 'Rajasthan',
          application_start_date: null,
          application_deadline: null,
          exam_date: null,
          admit_card_date: null,
          result_date: null,
          description: null,
          pdf_url: href.toLowerCase().includes('.pdf') && isPublicHttpUrl(href) ? href : null,
          source_url: href,
          published_date: dateMatch ? normalizeHumanDate(dateMatch[1]) : null,
        });
      }
    });
    return results.slice(0, 25);
  },
};

const employmentNewsParser: PortalParser = {
  parserKey: 'employmentnews',
  parse(html, sourceUrl = 'https://employmentnews.gov.in/NewEmp/AllJobs.aspx?k=All') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const cards = $('.employment-news-feed .en-notice-card');
    if (cards.length > 0) {
      cards.each((_, el) => {
        const card = $(el);
        const titleEl = card.find('.en-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        const meta: Record<string, string | null> = {};
        card.find('.en-meta span[data-en]').each((__, sp) => {
          const k = $(sp).attr('data-en');
          if (k) meta[k] = cleanText($(sp).text());
        });
        results.push({
          title,
          organization_name: 'Employment News (Ministry of I&B)',
          notification_number: cleanText(card.find('.en-ref').text()),
          vacancy_count: meta.vacancies ?? null,
          job_category: cleanText(card.attr('data-category')) || 'Central PSU & Ministries',
          qualification: cleanText(card.attr('data-qualification')),
          state: cleanText(card.attr('data-state')) || 'All India',
          application_start_date: meta.start ?? null,
          application_deadline: meta.deadline ?? null,
          exam_date: meta.exam ?? null,
          admit_card_date: meta.admit ?? null,
          result_date: meta.result ?? null,
          description: cleanText(card.find('.en-desc').text()),
          pdf_url: resolveUrl(sourceUrl, card.find('a.en-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: meta.published ?? null,
        });
      });
      return results;
    }

    // Live AllJobs.aspx?k=All table: ISSUED DATE (MM/DD/YYYY) | ORGANISATION | POST | METHOD | LAST DATE (DD/MM/YYYY)
    const seen = new Set<string>();
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 5) return;
      const issuedRaw = cleanText($(tds[0]).text());
      const orgRaw = cleanText($(tds[1]).text());
      const postRaw = cleanText($(tds[2]).text());
      const methodRaw = cleanText($(tds[3]).text());
      const lastDateRaw = cleanText($(tds[4]).text());
      if (!orgRaw || !postRaw || /issued\s*date|organisation/i.test(orgRaw)) return;

      const title = `${postRaw} — ${orgRaw}`;
      const dedupeKey = `${title.toLowerCase()}::${lastDateRaw || ''}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const pubIso = normalizeUsDate(issuedRaw);
      const deadlineIso = normalizeHumanDate(lastDateRaw);
      const anchorHref = resolveUrl(sourceUrl, $(tr).find('a').first().attr('href')) || sourceUrl;

      results.push({
        title,
        organization_name: orgRaw,
        notification_number: null,
        vacancy_count: null,
        job_category: methodRaw || 'Employment Gazette',
        qualification: null,
        state: 'All India',
        application_start_date: pubIso,
        application_deadline: deadlineIso,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: `Employment News Gazette · Organisation: ${orgRaw} · Method: ${methodRaw || 'Recruitment'}${deadlineIso ? ` · Closing Date: ${deadlineIso}` : ''}`,
        pdf_url: anchorHref.toLowerCase().endsWith('.pdf') && isPublicHttpUrl(anchorHref) ? anchorHref : null,
        source_url: anchorHref,
        published_date: pubIso,
      });
    });

    if (results.length > 0) {
      return results.slice(0, 30);
    }

    $('a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (title && href && title.length > 20 && /recruitment|vacancy|scientist|officer|apprentice|assistant/i.test(title)) {
        results.push({
          title,
          organization_name: 'Employment News (Ministry of I&B)',
          notification_number: null,
          vacancy_count: null,
          job_category: 'Central PSU & Ministries',
          qualification: null,
          state: 'All India',
          application_start_date: null,
          application_deadline: null,
          exam_date: null,
          admit_card_date: null,
          result_date: null,
          description: null,
          pdf_url: href.toLowerCase().includes('.pdf') && isPublicHttpUrl(href) ? href : null,
          source_url: href,
          published_date: null,
        });
      }
    });
    return results.slice(0, 25);
  },
};

const tnusrbParser: PortalParser = {
  parserKey: 'tnusrb',
  parse(html, sourceUrl = 'https://www.tnusrb.tn.gov.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const cards = $('.recruitment-panel .tnusrb-card');
    if (cards.length > 0) {
      cards.each((_, el) => {
        const card = $(el);
        const titleEl = card.find('h4 a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        const fields: Record<string, string | null> = {};
        card.find('ul.dates-list li[data-field]').each((__, li) => {
          const key = $(li).attr('data-field');
          if (key) fields[key] = cleanText($(li).text());
        });
        results.push({
          title,
          organization_name: 'Tamil Nadu Uniformed Services Recruitment Board (TNUSRB)',
          notification_number: cleanText(card.find('.notif-code').text()),
          vacancy_count: fields.vacancies ?? null,
          job_category: cleanText(card.attr('data-category')) || 'Police & Uniformed Services',
          qualification: cleanText(card.attr('data-qualification')),
          state: cleanText(card.attr('data-state')) || 'Tamil Nadu',
          application_start_date: fields.start ?? null,
          application_deadline: fields.deadline ?? null,
          exam_date: fields.exam ?? null,
          admit_card_date: fields.admit ?? null,
          result_date: fields.result ?? null,
          description: cleanText(card.find('p.details').text()),
          pdf_url: resolveUrl(sourceUrl, card.find('a.btn-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: fields.published ?? null,
        });
      });
      return results;
    }

    $('a[href*=".pdf"], a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (title && href && title.length > 18 && /sub-inspector|constable|recruitment|notification|brochure/i.test(title)) {
        const parentText = cleanText($(el).closest('li, tr, div').text()) || '';
        const dateMatch = parentText.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);
        results.push({
          title,
          organization_name: 'Tamil Nadu Uniformed Services Recruitment Board (TNUSRB)',
          notification_number: null,
          vacancy_count: null,
          job_category: 'Police & Uniformed Services',
          qualification: null,
          state: 'Tamil Nadu',
          application_start_date: null,
          application_deadline: null,
          exam_date: null,
          admit_card_date: null,
          result_date: null,
          description: null,
          pdf_url: href.toLowerCase().includes('.pdf') && isPublicHttpUrl(href) ? href : null,
          source_url: href,
          published_date: dateMatch ? normalizeHumanDate(dateMatch[1]) : null,
        });
      }
    });
    return results.slice(0, 25);
  },
};

const rrbcdgParser: PortalParser = {
  parserKey: 'rrbcdg',
  parse(html, sourceUrl = 'https://www.rrbcdg.gov.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const rows = $('table.cen-notice-table tbody tr');
    if (rows.length > 0) {
      rows.each((_, el) => {
        const row = $(el);
        const titleEl = row.find('td.cen-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'Railway Recruitment Boards (RRB Chandigarh)',
          notification_number: cleanText(row.find('td.cen-id').text()),
          vacancy_count: cleanText(row.find('td.cen-posts').text()),
          job_category: cleanText(row.attr('data-cat')) || 'Indian Railways',
          qualification: cleanText(row.attr('data-qualification')),
          state: cleanText(row.attr('data-state')) || 'All India',
          application_start_date: cleanText(row.find('td.cen-open').text()),
          application_deadline: cleanText(row.find('td.cen-close').text()),
          exam_date: cleanText(row.find('td.cen-cbt').text()),
          admit_card_date: cleanText(row.find('td.cen-ecall').text()),
          result_date: cleanText(row.find('td.cen-res').text()),
          description: cleanText(row.find('td.cen-summary').text()),
          pdf_url: resolveUrl(sourceUrl, row.find('td.cen-doc a').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(row.find('td.cen-pub').text()),
        });
      });
      return results;
    }

    $('a[href*=".pdf"], table a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (title && href && title.length > 18 && /cen|alp|ntpc|technician|admit|result/i.test(title)) {
        const parentText = cleanText($(el).closest('li, tr, div').text()) || '';
        const dateMatch = parentText.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);
        results.push({
          title,
          organization_name: 'Railway Recruitment Boards (RRB Chandigarh)',
          notification_number: title.match(/CEN\s*\d+\/\d{4}/i)?.[0] || null,
          vacancy_count: null,
          job_category: 'Indian Railways',
          qualification: null,
          state: 'All India',
          application_start_date: null,
          application_deadline: null,
          exam_date: null,
          admit_card_date: null,
          result_date: null,
          description: null,
          pdf_url: href.toLowerCase().includes('.pdf') && isPublicHttpUrl(href) ? href : null,
          source_url: href,
          published_date: dateMatch ? normalizeHumanDate(dateMatch[1]) : null,
        });
      }
    });
    return results.slice(0, 25);
  },
};

const ibpsParser: PortalParser = {
  parserKey: 'ibps',
  parse(html, sourceUrl = 'https://www.ibps.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const items = $('.crp-notification-list .crp-item');
    if (items.length > 0) {
      items.each((_, el) => {
        const item = $(el);
        const titleEl = item.find('h3 a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        const kv: Record<string, string | null> = {};
        item.find('dl.crp-dates dd[data-key]').each((__, dd) => {
          const key = $(dd).attr('data-key');
          if (key) kv[key] = cleanText($(dd).text());
        });
        results.push({
          title,
          organization_name: 'Institute of Banking Personnel Selection (IBPS)',
          notification_number: cleanText(item.find('.crp-ref').text()),
          vacancy_count: kv.vacancies ?? null,
          job_category: cleanText(item.attr('data-stream')) || 'Public Sector Banking',
          qualification: cleanText(item.attr('data-qualification')),
          state: cleanText(item.attr('data-state')) || 'All India',
          application_start_date: kv.start ?? null,
          application_deadline: kv.deadline ?? null,
          exam_date: kv.exam ?? null,
          admit_card_date: kv.admit ?? null,
          result_date: kv.result ?? null,
          description: cleanText(item.find('p.crp-desc').text()),
          pdf_url: resolveUrl(sourceUrl, item.find('a.crp-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: kv.published ?? null,
        });
      });
      return results;
    }

    const seen = new Set<string>();
    $('a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (!title || !href || !isPublicHttpUrl(href) || title.length < 18) return;
      if (/^CRP\s*[-\s]?(RRBs|CSA.*|PO\/MTs|Clerks|Specialist Officer(?:s)?|Clerical cadre)$/i.test(title)) return;
      if (/\/index\.php\/(?:specialist-officers|clerical-cadre|po-mt|regional-rural-bank|overview|career)\/?$/i.test(href)) return;
      const isIbpsReg = /ibpsreg\.ibps\.in/i.test(href);
      const isCrpOrNotice = /CRP|Notification for Common Recruitment|Provisional Allotment|Result|Call Letter|Recruitment of|Engagement of/i.test(title);
      if (!isCrpOrNotice && !isIbpsReg) return;

      const dedupeKey = title.toLowerCase();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const crpMatch = title.match(/CRP[-\sA-Z/]+(?:XVII|XVI|XV|XIV)/i)?.[0] || null;
      const regCode = isIbpsReg ? href.replace(/\/+$/, '').split('/').pop()?.toUpperCase() || null : null;
      const isPdf = href.toLowerCase().includes('.pdf');
      const fileDateMatch = isPdf ? href.match(/(\d{2}\.\d{2}\.\d{4})\.pdf$/i) : null;
      const regFromMatch = title.match(/Registration\s+From\s+(\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
      const parentText = cleanText($(el).closest('li, p, div').text()) || '';
      const parentDateMatch = parentText.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);

      const regStartDate = regFromMatch ? normalizeHumanDate(regFromMatch[1]) : null;
      const pubDate =
        regStartDate ||
        (fileDateMatch ? normalizeHumanDate(fileDateMatch[1]) : null) ||
        (parentDateMatch ? normalizeHumanDate(parentDateMatch[1]) : null);

      const cleanTitle = title.replace(/\s*Registration\s+From\s+\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}\s*$/i, '').trim() || title;

      results.push({
        title: cleanTitle,
        organization_name: 'Institute of Banking Personnel Selection (IBPS)',
        notification_number: crpMatch || (regCode ? `IBPS-${regCode}` : null),
        vacancy_count: null,
        job_category: isIbpsReg ? 'IBPS Active Recruitment Portal' : 'Public Sector Banking',
        qualification: null,
        state: 'All India',
        application_start_date: regStartDate,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: /provisional allotment|result/i.test(cleanTitle) && pubDate ? pubDate : null,
        description: regStartDate ? `IBPS Online Registration Portal · Opens ${regStartDate}` : null,
        pdf_url: isPdf && isPublicHttpUrl(href) ? href : null,
        source_url: isPdf ? sourceUrl : href,
        published_date: pubDate,
      });
    });
    return results.slice(0, 30);
  },
};

const sbiParser: PortalParser = {
  parserKey: 'sbi',
  parse(html, sourceUrl = 'https://sbi.co.in/web/careers/current-openings') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];

    const fixtureRows = $('table.sbi-careers-table tbody tr.sbi-opening');
    if (fixtureRows.length > 0) {
      fixtureRows.each((_, el) => {
        const row = $(el);
        const titleEl = row.find('td.title-col a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'State Bank of India (SBI Careers)',
          notification_number: cleanText(row.find('td.advt-col').text()),
          vacancy_count: cleanText(row.find('td.vac-col').text()),
          job_category: cleanText(row.attr('data-category')) || 'SBI Banking Recruitment',
          qualification: cleanText(row.attr('data-qualification')),
          state: cleanText(row.attr('data-state')) || 'All India',
          application_start_date: cleanText(row.find('td.start-col').text()),
          application_deadline: cleanText(row.find('td.end-col').text()),
          exam_date: cleanText(row.find('td.exam-col').text()),
          admit_card_date: cleanText(row.find('td.admit-col').text()),
          result_date: cleanText(row.find('td.res-col').text()),
          description: cleanText(row.find('td.title-col .opening-note').text()),
          pdf_url: resolveUrl(sourceUrl, row.find('td.pdf-col a').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(row.find('td.pub-col').text()),
        });
      });
      return results;
    }

    const seen = new Set<string>();
    $('li.icon-touch a[href*=".pdf"], .accordion-body a[href*=".pdf"], .panel-body a[href*=".pdf"]').each((_, a) => {
      const rawHref = $(a).attr('href') || '';
      const linkText = cleanText($(a).text()) || '';
      if (/hindi|corrigendum/i.test(linkText) && !/english/i.test(linkText)) return;
      if (!/english|adv|detailed|notification|download/i.test(linkText + rawHref)) return;
      const resolvedPdf = resolveUrl(sourceUrl, rawHref);
      if (!isPublicHttpUrl(resolvedPdf)) return;

      const collapseDiv = $(a).closest('.panel-collapse, .accordion-collapse, .collapse, .card-body');
      const prevTitle = cleanText(collapseDiv.prev().text());
      const card = $(a).closest('.panel, .card, .accordion-item');
      const cardMeta = cleanText(card.find('h3, h4, h5, button, .panel-title, .accordion-button').first().text()) || '';
      const rawTitle = prevTitle || cardMeta;
      if (!rawTitle || rawTitle.length < 15) return;

      const fullCardText = cleanText(card.text()) || cardMeta;
      const cleanTitle = cleanText(rawTitle.replace(/\(Apply Online from[^)]+\)/gi, '')) || rawTitle;
      if (seen.has(cleanTitle)) return;
      seen.add(cleanTitle);

      const windowMatch = fullCardText.match(
        /Apply Online from\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*TO\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i
      );
      const startDate = windowMatch ? normalizeHumanDate(windowMatch[1]) : null;
      const windowEndDate = windowMatch ? normalizeHumanDate(windowMatch[2]) : null;
      const lastDateMatch = fullCardText.match(/LAST DATE TO APPLY\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
      const deadline = (lastDateMatch ? normalizeHumanDate(lastDateMatch[1]) : null) || windowEndDate;

      const advtMatch =
        fullCardText.match(/ADVERTISEMENT NO:\s*([A-Z0-9/_-]+)/i)?.[1] ||
        rawHref.match(/CRPD[-_][A-Z0-9_-]+|SCO-\d+/i)?.[0] ||
        null;

      results.push({
        title: cleanTitle,
        organization_name: 'State Bank of India (SBI Careers)',
        notification_number: advtMatch,
        vacancy_count: null,
        job_category: 'SBI Banking Recruitment',
        qualification: null,
        state: 'All India',
        application_start_date: startDate,
        application_deadline: deadline,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: advtMatch
          ? `SBI Current Opening (${advtMatch})${startDate && deadline ? ` · Online window ${startDate} to ${deadline}` : ''}`
          : null,
        pdf_url: resolvedPdf,
        source_url: sourceUrl,
        published_date: startDate,
      });
    });
    return results.slice(0, 30);
  },
};

const rbiParser: PortalParser = {
  parserKey: 'rbi',
  parse(html, sourceUrl = 'https://opportunities.rbi.org.in/Scripts/Vacancies.aspx') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const notices = $('.rbi-vacancies-list .rbi-notice');
    if (notices.length > 0) {
      notices.each((_, el) => {
        const notice = $(el);
        const titleEl = notice.find('a.rbi-link').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'Reserve Bank of India (RBI Opportunities)',
          notification_number: cleanText(notice.find('.rbi-advt').text()),
          vacancy_count: cleanText(notice.find('.f-vac').text()),
          job_category: cleanText(notice.attr('data-category')) || 'Central Banking',
          qualification: cleanText(notice.attr('data-qualification')),
          state: cleanText(notice.attr('data-state')) || 'All India',
          application_start_date: cleanText(notice.find('.f-start').text()),
          application_deadline: cleanText(notice.find('.f-deadline').text()),
          exam_date: cleanText(notice.find('.f-exam').text()),
          admit_card_date: cleanText(notice.find('.f-admit').text()),
          result_date: cleanText(notice.find('.f-result').text()),
          description: cleanText(notice.find('p.rbi-summary').text()),
          pdf_url: resolveUrl(sourceUrl, notice.find('a.rbi-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(notice.find('.f-pub').text()),
        });
      });
      return results;
    }

    const seen = new Set<string>();
    $('a[href*="bs_viewcontent"]').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (!title || !href || title.length < 18) return;
      if (/^(Recruitment|Promotion|Rosters at ROs)$/i.test(title)) return;
      if (seen.has(href)) return;
      seen.add(href);

      const idMatch = href.match(/[?&]Id=(\d+)/i);
      results.push({
        title,
        organization_name: 'Reserve Bank of India (RBI Opportunities)',
        notification_number: idMatch ? `RBI-VAC-${idMatch[1]}` : null,
        vacancy_count: null,
        job_category: 'Central Banking',
        qualification: null,
        state: 'All India',
        application_start_date: null,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: null,
        pdf_url: null,
        source_url: href,
        published_date: null,
      });
    });

    // Also include direct PDF calendars/notices linked on Vacancies.aspx (e.g. Annual Recruitment Calendar)
    $('a[href*=".pdf"]').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (!title || !href || title.length < 18 || !isPublicHttpUrl(href) || seen.has(href)) return;
      if (!/recruitment|calendar|vacancy|officer|assistant/i.test(title + href)) return;
      seen.add(href);
      results.push({
        title,
        organization_name: 'Reserve Bank of India (RBI Opportunities)',
        notification_number: 'RBI-CALENDAR',
        vacancy_count: null,
        job_category: 'Central Banking Schedule',
        qualification: null,
        state: 'All India',
        application_start_date: null,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: 'Official RBI Annual Recruitment Calendar & Exam Schedule PDF.',
        pdf_url: href,
        source_url: sourceUrl,
        published_date: null,
      });
    });

    return results.slice(0, 25);
  },
};

const ntaParser: PortalParser = {
  parserKey: 'nta',
  parse(html, sourceUrl = 'https://nta.ac.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const rows = $('section.public-notices-grid .nta-notice-row');
    if (rows.length > 0) {
      rows.each((_, el) => {
        const row = $(el);
        const titleEl = row.find('.nta-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        const meta: Record<string, string | null> = {};
        row.find('.nta-meta span[data-m]').each((__, sp) => {
          const key = $(sp).attr('data-m');
          if (key) meta[key] = cleanText($(sp).text());
        });
        results.push({
          title,
          organization_name: 'National Testing Agency (NTA)',
          notification_number: cleanText(row.find('.nta-ref').text()),
          vacancy_count: meta.vacancies ?? null,
          job_category: cleanText(row.attr('data-category')) || 'National Examination',
          qualification: cleanText(row.attr('data-qualification')),
          state: cleanText(row.attr('data-state')) || 'All India',
          application_start_date: meta.start ?? null,
          application_deadline: meta.deadline ?? null,
          exam_date: meta.exam ?? null,
          admit_card_date: meta.admit ?? null,
          result_date: meta.result ?? null,
          description: cleanText(row.find('p.nta-desc').text()),
          pdf_url: resolveUrl(sourceUrl, row.find('a.nta-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: meta.published ?? null,
        });
      });
      return results;
    }

    const seen = new Set<string>();
    const datedResults: ParsedNotification[] = [];
    const generalResults: ParsedNotification[] = [];
    $('a[href*="/Download/Notice/"], a[href*=".pdf"]').each((_, a) => {
      const href = resolveUrl(sourceUrl, $(a).attr('href'));
      if (!href || !isPublicHttpUrl(href) || !/\.pdf/i.test(href)) return;
      const parentP = $(a).closest('p, li, div, tr');
      const contentTitle = cleanText(parentP.find('content').first().text());
      const fallbackParent = cleanText(parentP.clone().find('a').remove().end().text());
      const linkText = cleanText($(a).text());
      const title =
        contentTitle ||
        (fallbackParent && fallbackParent.length > 15 ? fallbackParent : null) ||
        (linkText && !/^read\s*more$/i.test(linkText) ? linkText : null);
      if (!title || title.length < 12 || seen.has(title)) return;
      if (/^procedure for duplicate score card$/i.test(title)) return;
      seen.add(title);

      const pubDate = normalizeHumanDate(href);
      const inlineDate = normalizeHumanDate(title);
      const isAdmit = /admit\s*card|city\s*intimation/i.test(title);
      const isResult = /result|score\s*card|answer\s*key/i.test(title);
      const category = isAdmit
        ? 'Admit Card / Intimation'
        : isResult
          ? 'Examination Result'
          : 'National Examination Notice';

      const entry: ParsedNotification = {
        title,
        organization_name: 'National Testing Agency (NTA)',
        notification_number: null,
        vacancy_count: null,
        job_category: category,
        qualification: null,
        state: 'All India',
        application_start_date: null,
        application_deadline: null,
        exam_date: /schedule|exam/i.test(title) && inlineDate ? inlineDate : null,
        admit_card_date: isAdmit ? pubDate : null,
        result_date: isResult ? pubDate : null,
        description: pubDate ? `Official NTA Public Notice released on ${pubDate}.` : null,
        pdf_url: href,
        source_url: sourceUrl,
        published_date: pubDate,
      };
      if (pubDate) {
        datedResults.push(entry);
      } else {
        generalResults.push(entry);
      }
    });

    const combinedNta = [...datedResults, ...generalResults];
    if (combinedNta.length > 0) {
      return combinedNta.slice(0, 30);
    }

    $('a').each((_, el) => {
      const title = cleanText($(el).text());
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      if (!title || !href || title.length < 15 || seen.has(title)) return;
      if (/nta\.nic\.in|Notice|Examination|CUET|JEE|NEET|UGC|AISSEE|NCET|SWAYAM/i.test(title + href)) {
        seen.add(title);
        results.push({
          title,
          organization_name: 'National Testing Agency (NTA)',
          notification_number: null,
          vacancy_count: null,
          job_category: 'National Examination',
          qualification: null,
          state: 'All India',
          application_start_date: null,
          application_deadline: null,
          exam_date: null,
          admit_card_date: null,
          result_date: null,
          description: null,
          pdf_url: href.toLowerCase().includes('.pdf') ? href : null,
          source_url: href,
          published_date: null,
        });
      }
    });
    return results.slice(0, 25);
  },
};

export function parseNtaExamCalendarPdfText(text: string, calendarPdfUrl: string): ParsedNotification[] {
  if (!text || text.length < 40) return [];
  const entries: { pattern: RegExp; title: string; keywords: string[]; defaultExam: string }[] = [
    { pattern: /Rashtriya\s+Indian\s+Military\s+College\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — Rashtriya Indian Military College (RIMC) Entrance Exam', keywords: ['rimc', 'rashtriya indian military'], defaultExam: '' },
    { pattern: /SWAYAM\s+(\d{1,2})\s*[–-]\s*\d{1,2}\s+([A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — SWAYAM December 2026 Examination', keywords: ['swayam'], defaultExam: '' },
    { pattern: /Rashtriya\s+Military\s+Schools\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — Rashtriya Military Schools (RMS CET) Examination', keywords: ['rashtriya military schools', 'rms'], defaultExam: '' },
    { pattern: /UGC\s+NET\s*\(December\s+Cycle\)\s+(\d{1,2})[^A-Za-z]{1,20}([A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — UGC NET (December 2026 Cycle)', keywords: ['ugc-net', 'ugc net'], defaultExam: '' },
    { pattern: /Joint\s+CSIR\s+UGC\s+NET\s*\(December\s+Cycle\)\s+(\d{1,2})[^A-Za-z]{1,20}([A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — Joint CSIR-UGC NET (December 2026 Cycle)', keywords: ['csir', 'csir-ugc'], defaultExam: '' },
    { pattern: /Army\s+Cadets\s+College\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — Army Cadets College (ACC) Examination 2027', keywords: ['army cadets'], defaultExam: '' },
    { pattern: /SHRESHTA\s*\(NETS\)[^0-9]{1,85}(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — SHRESHTA (NETS) Examination 2027', keywords: ['shreshta'], defaultExam: '' },
    { pattern: /NIFT\s+Entrance\s+Examination\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — NIFT Entrance Examination (NIFTEE) 2027', keywords: ['nift', 'niftee'], defaultExam: '' },
    { pattern: /JEE\s*\(Main\)\s*[—–-]\s*Session\s*1[^0-9]{1,25}(\d{1,2})[^A-Za-z]{1,20}([A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — JEE (Main) 2027 Session 1', keywords: ['jee (main)', 'jee main'], defaultExam: '' },
    { pattern: /All\s+India\s+Sainik\s+Schools\s+Entrance\s+Examination\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — All India Sainik Schools Entrance Examination (AISSEE) 2027', keywords: ['sainik', 'aissee'], defaultExam: '' },
    { pattern: /Common\s+Management\s+Admission\s+Test\s*\(CMAT\)\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — Common Management Admission Test (CMAT) 2027', keywords: ['cmat'], defaultExam: '' },
    { pattern: /CUET\s*\(PG\)[^0-9]{1,75}(\d{1,2})[^A-Za-z]{1,40}([A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — CUET (PG) 2027 Examination', keywords: ['cuet (pg)', 'cuet pg'], defaultExam: '' },
    { pattern: /JEE\s*\(Main\)\s*[—–-]\s*Session\s*2[^0-9]{1,25}(\d{1,2})\s*[–-]\s*\d{1,2}\s+([A-Za-z]{3,9}\s+\d{4})/i, title: 'NTA — JEE (Main) 2027 Session 2', keywords: ['session 2'], defaultExam: '' },
  ];

  const out: ParsedNotification[] = [];
  for (const spec of entries) {
    const m = text.match(spec.pattern);
    if (!m) continue;
    const rawDate = m[2] ? `${m[1]} ${m[2]}` : m[1];
    const examIso = normalizeHumanDate(rawDate);
    if (!examIso) continue;

    const slug = spec.title.replace(/^NTA\s*[—–-]\s*/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).toUpperCase();
    out.push({
      title: spec.title,
      organization_name: 'National Testing Agency (NTA)',
      notification_number: `NTA-CAL-${slug}`,
      vacancy_count: null,
      job_category: 'National Examination Schedule',
      qualification: null,
      state: 'All India',
      application_start_date: null,
      application_deadline: null,
      exam_date: examIso,
      admit_card_date: null,
      result_date: null,
      description: `Official NTA Examination Calendar Date: ${examIso}`,
      pdf_url: calendarPdfUrl,
      source_url: 'https://nta.ac.in/',
      published_date: null,
    });
  }
  return out;
}

const indiapostParser: PortalParser = {
  parserKey: 'indiapost',
  parse(html, sourceUrl = 'https://indiapostgdsonline.gov.in/') {
    const $ = cheerio.load(html);
    const results: ParsedNotification[] = [];
    const entries = $('.gds-engagement-list .indiapost-entry');
    if (entries.length > 0) {
      entries.each((_, el) => {
        const entry = $(el);
        const titleEl = entry.find('h4.ip-title a').first();
        const title = cleanText(titleEl.text());
        if (!title) return;
        results.push({
          title,
          organization_name: 'India Post — Department of Posts',
          notification_number: cleanText(entry.find('.ip-notif-no').text()),
          vacancy_count: cleanText(entry.find('.ip-vac').text()),
          job_category: cleanText(entry.attr('data-category')) || 'Postal Services',
          qualification: cleanText(entry.attr('data-qualification')),
          state: cleanText(entry.attr('data-state')) || 'All India',
          application_start_date: cleanText(entry.find('.ip-start').text()),
          application_deadline: cleanText(entry.find('.ip-deadline').text()),
          exam_date: cleanText(entry.find('.ip-exam').text()),
          admit_card_date: cleanText(entry.find('.ip-admit').text()),
          result_date: cleanText(entry.find('.ip-result').text()),
          description: cleanText(entry.find('p.ip-desc').text()),
          pdf_url: resolveUrl(sourceUrl, entry.find('a.ip-pdf').attr('href')),
          source_url: resolveUrl(sourceUrl, titleEl.attr('href')) || sourceUrl,
          published_date: cleanText(entry.find('.ip-pub').text()),
        });
      });
      return results;
    }

    const seen = new Set<string>();

    // Live indiapostgdsonline.gov.in circulars & annexures & DV schedules
    $('a[href*=".pdf"], a[href*=".PDF"]').each((_, el) => {
      const href = resolveUrl(sourceUrl, $(el).attr('href'));
      const linkText = cleanText($(el).text());
      if (!href || !isPublicHttpUrl(href)) return;

      const fileName = href.split('/').pop()?.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ') || '';
      const parentCtx = cleanText($(el).closest('li, div, p, td').parent().text()) || '';
      const isDvList = /DocVerList|_DV_List/i.test(href);
      const circleMatch = fileName.match(/^([A-Za-z ]+?)\s+DV\s+List\s*(\d+)/i);

      let title = '';
      if (isDvList && circleMatch) {
        title = `India Post GDS — ${circleMatch[1]} Circle Document Verification List ${circleMatch[2]}`;
      } else if (/Notifications1/i.test(href)) {
        title = `India Post GDS Notification — ${linkText || fileName} (${fileName})`;
      } else if (linkText && linkText.length > 15 && /gds|gramin|recruit|vacancy|engagement|shortlist|post/i.test(linkText + fileName)) {
        title = linkText;
      } else {
        return;
      }

      if (seen.has(title.toLowerCase())) return;
      seen.add(title.toLowerCase());

      results.push({
        title,
        organization_name: 'India Post — Department of Posts',
        notification_number: /Notifications1/i.test(href) ? `GDS-${fileName.replace(/\s+/g, '-').slice(0, 24)}` : null,
        vacancy_count: null,
        job_category: isDvList ? 'GDS Shortlist / Result' : 'Postal Services',
        qualification: '10th Pass',
        state: circleMatch ? circleMatch[1] : 'All India',
        application_start_date: null,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: isDvList ? normalizeHumanDate(parentCtx) : null,
        description: `India Post GDS Official Circular (${fileName})`,
        pdf_url: href,
        source_url: sourceUrl,
        published_date: null,
      });
    });

    if (results.length > 0) {
      return results.slice(0, 25);
    }

    // Fallback RSC parser for indiapost.gov.in (strictly filtered for real recruitment docs only)
    const unescaped = html.replace(/\\"/g, '"');
    const rscRegex =
      /"title"\s*:\s*"([^"]{15,300})"\s*,\s*"category"\s*:\s*"([^"]*)"\s*,\s*"date"\s*:\s*"([^"]*)"[^}]{0,220}?"version"\s*:\s*"([^"]*)"[^}]{0,120}?"url"\s*:\s*"(\/api\/documents\/file\/[^"]+)"/g;
    let m: RegExpExecArray | null;
    const englishFirst: ParsedNotification[] = [];
    const otherLangs: ParsedNotification[] = [];

    while ((m = rscRegex.exec(unescaped)) !== null) {
      const title = cleanText(m[1]);
      const rawCat = cleanText(m[2]) || 'Postal Services';
      const pubDate = normalizeHumanDate(m[3]);
      const version = cleanText(m[4]) || '';
      const pdfUrl = resolveUrl(sourceUrl, m[5]);
      if (!title || !pdfUrl || !isPublicHttpUrl(pdfUrl)) continue;
      if (/message from hon|minister|recruitment\s*rules/i.test(title)) continue;
      if (!/gds|gramin\s*dak|recruit|engagement|vacancy|shortlist|postal\s*assistant|postman|mts/i.test(`${title} ${rawCat}`)) {
        continue;
      }
      if (/^hindi version$/i.test(version) && englishFirst.some((r) => r.title === title)) continue;
      const dedupeKey = title.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const vacMatch = title.match(/\b(\d{1,4})\s+(?:vacant\s+)?posts?\b/i);
      const notifNoMatch = title.match(/\bNo\.?\s*([A-Z0-9/-]+(?:-\d{4})?)\b/i);
      const parsed: ParsedNotification = {
        title,
        organization_name: 'India Post — Department of Posts',
        notification_number: notifNoMatch ? notifNoMatch[1] : null,
        vacancy_count: vacMatch ? vacMatch[1] : null,
        job_category: /recruit/i.test(rawCat) ? 'Postal Recruitment' : rawCat,
        qualification: null,
        state: 'All India',
        application_start_date: null,
        application_deadline: null,
        exam_date: null,
        admit_card_date: null,
        result_date: null,
        description: version ? `India Post ${rawCat} (${version})` : `India Post ${rawCat}`,
        pdf_url: pdfUrl,
        source_url: sourceUrl,
        published_date: pubDate,
      };
      if (/english/i.test(version)) {
        englishFirst.push(parsed);
      } else {
        otherLangs.push(parsed);
      }
    }

    const rscCombined = [...englishFirst, ...otherLangs];
    if (rscCombined.length > 0) {
      return rscCombined.slice(0, 25);
    }

    return results.slice(0, 20);
  },
};

export const PARSER_REGISTRY: Record<string, PortalParser> = {
  upsc: upscParser,
  ssc: sscParser,
  tnpsc: tnpscParser,
  keralapsc: keralaPscParser,
  rpsc: rpscParser,
  employmentnews: employmentNewsParser,
  tnusrb: tnusrbParser,
  rrbcdg: rrbcdgParser,
  ibps: ibpsParser,
  sbi: sbiParser,
  rbi: rbiParser,
  nta: ntaParser,
  indiapost: indiapostParser,
};

export function getParser(parserKey: string): PortalParser {
  const parser = PARSER_REGISTRY[parserKey];
  if (!parser) {
    throw new Error(`Unsupported parser_key: ${parserKey}`);
  }
  return parser;
}
