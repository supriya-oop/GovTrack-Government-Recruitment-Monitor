export interface ParsedNotification {
  title: string;
  organization_name: string;
  notification_number: string | null;
  vacancy_count: string | null;
  job_category: string | null;
  qualification: string | null;
  state: string | null;
  application_procedure?: string | null;
  application_start_date: string | null;
  application_deadline: string | null;
  exam_date: string | null;
  admit_card_date: string | null;
  result_date: string | null;
  description: string | null;
  pdf_url: string | null;
  source_url: string;
  published_date: string | null;
  notification_status?: string | null;
}

export function cleanText(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function resolveUrl(baseUrl: string, href?: string | null): string | null {
  const cleaned = cleanText(href);
  if (!cleaned) return null;
  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return cleaned;
  }
}

export interface PortalParser {
  parserKey: string;
  parse(html: string, sourceUrl?: string): ParsedNotification[];
}
