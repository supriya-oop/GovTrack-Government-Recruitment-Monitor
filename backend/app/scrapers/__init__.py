from .portals import (
    EmploymentNewsParser,
    IbpsParser,
    IndiaPostParser,
    KeralaPscParser,
    NtaParser,
    RbiParser,
    RpscParser,
    RrbCdgParser,
    SbiParser,
    SscParser,
    TnpscParser,
    TnusrbParser,
    UpscParser,
    extract_ibps_subpage_dates,
    parse_kerala_psc_gazette_subpage,
    parse_nta_exam_calendar_pdf_text,
    parse_rbi_detail_html,
    parse_tnpsc_annual_planner_html,
    parse_tnpsc_dashboard_detail_html,
    parse_upsc_detail_html,
)

PARSER_REGISTRY = {
    "upsc": UpscParser(),
    "ssc": SscParser(),
    "ibps": IbpsParser(),
    "sbi": SbiParser(),
    "rrbcdg": RrbCdgParser(),
    "employmentnews": EmploymentNewsParser(),
    "nta": NtaParser(),
    "tnpsc": TnpscParser(),
    "keralapsc": KeralaPscParser(),
    "rpsc": RpscParser(),
    "tnusrb": TnusrbParser(),
    "rbi": RbiParser(),
    "indiapost": IndiaPostParser(),
}


def get_parser(parser_key: str):
    parser = PARSER_REGISTRY.get(parser_key)
    if not parser:
        raise ValueError(f"Unsupported parser_key: {parser_key}")
    return parser


__all__ = [
    "PARSER_REGISTRY",
    "get_parser",
    "extract_ibps_subpage_dates",
    "parse_kerala_psc_gazette_subpage",
    "parse_nta_exam_calendar_pdf_text",
    "parse_rbi_detail_html",
    "parse_tnpsc_annual_planner_html",
    "parse_tnpsc_dashboard_detail_html",
    "parse_upsc_detail_html",
]
