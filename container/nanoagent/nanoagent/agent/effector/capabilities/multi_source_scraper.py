"""Ported from computer-use/multi-source-scraper.ts. Entity normalization,
honeypot filtering, business-email validation, Jaro-Winkler fuzzy matching, and
cascading multi-provider enrichment for B2B contact discovery — the machinery a
lead-enrichment blueprint runs on."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from loguru import logger

DISPOSABLE_DOMAINS = frozenset({
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
    "throwawaymail.com", "trashmail.com", "sharklasers.com", "yopmail.com",
})

_COMPANY_LEGAL_SUFFIXES = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\binc\.?$", r"\bllc\.?$", r"\bltd\.?$", r"\bcorp\.?$", r"\bcorporation\.?$",
        r"\bgmbh\.?$", r"\bpvt\.?\s*ltd\.?$", r"\bco\.?$", r"\bcompany\.?$",
        r"\bholdings\.?$", r"\btechnologies\.?$", r"\btech\.?$",
    ]
]


@dataclass
class ScraperDOMElement:
    bounds: dict[str, float]
    center: dict[str, float] | None = None
    text: str | None = None
    name: str | None = None
    tag: str | None = None
    ref: str | None = None
    is_visible: bool = True
    is_enabled: bool = True


@dataclass
class ScrapedEntity:
    name: str = ""
    company: str = ""
    title: str | None = None
    seniority: str | None = None       # 'C-Level'|'VP'|'Director'|'Manager'|'Senior'|'Lead'|'Entry'
    department: str | None = None       # 'Engineering'|'Sales'|'Marketing'|'Product'|'Operations'|'Finance'|'Legal'|'HR'
    normalized_company: str | None = None
    email: str | None = None
    domain: str | None = None
    linkedin_url: str | None = None
    phone: str | None = None
    location: str | None = None
    confidence: float = 0.6
    sources: list[str] = field(default_factory=list)


@dataclass
class EnrichmentProvider:
    name: str
    priority: int
    enrich: Callable[[ScrapedEntity], Awaitable[dict[str, Any] | None]]


def normalize_company_name(company: str) -> str:
    """Clean and normalize a company name for cross-source matching."""
    cleaned = company.strip()
    for suffix in _COMPANY_LEGAL_SUFFIXES:
        cleaned = suffix.sub("", cleaned).strip()
    cleaned = re.sub(r"[,\-._]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
    return cleaned


def classify_title(title: str | None) -> tuple[str | None, str | None]:
    """Classify seniority and department from a raw title string. Returns
    (seniority, department)."""
    if not title:
        return None, None
    t = title.lower()

    if any(w in t for w in ("chief", "ceo", "cto", "cfo", "coo", "founder", "president")):
        seniority = "C-Level"
    elif "vp" in t or "vice president" in t:
        seniority = "VP"
    elif "director" in t or "head of" in t:
        seniority = "Director"
    elif any(w in t for w in ("lead", "principal", "staff")):
        seniority = "Lead"
    elif "manager" in t:
        seniority = "Manager"
    elif "senior" in t or "sr." in t or "sr " in t:
        seniority = "Senior"
    else:
        seniority = "Entry"

    if any(w in t for w in ("engineer", "developer", "architect", "software", "devops", "data", "technology", "tech", "cto")):
        department = "Engineering"
    elif any(w in t for w in ("sales", "account", "business development", "bdr", "sdr")):
        department = "Sales"
    elif any(w in t for w in ("marketing", "growth", "seo", "content")):
        department = "Marketing"
    elif any(w in t for w in ("product", "pm", "designer", "ux")):
        department = "Product"
    elif any(w in t for w in ("finance", "accounting", "controller")):
        department = "Finance"
    elif any(w in t for w in ("hr", "people", "talent", "recruiter")):
        department = "HR"
    elif any(w in t for w in ("legal", "counsel", "compliance")):
        department = "Legal"
    else:
        department = "Operations"

    return seniority, department


def filter_honeypots(elements: list[ScraperDOMElement]) -> list[ScraperDOMElement]:
    """Filter out invisible honeypot elements planted by bot-detection scripts."""
    out = []
    for el in elements:
        if el.bounds.get("width", 0) <= 0 or el.bounds.get("height", 0) <= 0:
            continue
        if el.bounds.get("x", 0) < 0 or el.bounds.get("y", 0) < 0:
            continue
        text = (el.text or "").lower()
        name = (el.name or "").lower()
        if ("leave this field empty" in text or "honeypot" in name
                or "bot_check" in name or "hp_field" in name):
            continue
        out.append(el)
    return out


_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")


def is_valid_business_email(email: str | None) -> bool:
    """Validate email syntax and reject disposable-domain addresses."""
    if not email:
        return False
    clean = email.strip().lower()
    if not _EMAIL_RE.match(clean):
        return False
    domain = clean.split("@")[1]
    return domain not in DISPOSABLE_DOMAINS


def string_similarity(s1: str, s2: str) -> float:
    """Jaro-Winkler string similarity between two strings."""
    str1, str2 = s1.lower().strip(), s2.lower().strip()
    if str1 == str2:
        return 1.0
    if not str1 or not str2:
        return 0.0

    max_dist = max(len(str1), len(str2)) // 2 - 1
    s1_matches = [False] * len(str1)
    s2_matches = [False] * len(str2)
    matches = 0

    for i in range(len(str1)):
        start = max(0, i - max_dist)
        end = min(i + max_dist + 1, len(str1))
        for j in range(start, min(end, len(str2))):
            if not s2_matches[j] and str1[i] == str2[j]:
                s1_matches[i] = True
                s2_matches[j] = True
                matches += 1
                break

    if matches == 0:
        return 0.0

    t = 0
    point = 0
    for i in range(len(str1)):
        if s1_matches[i]:
            while not s2_matches[point]:
                point += 1
            if str1[i] != str2[point]:
                t += 1
            point += 1

    m = matches
    return (m / len(str1) + m / len(str2) + (m - t / 2) / m) / 3


def merge_entity_records(target: ScrapedEntity, source: dict[str, Any]) -> ScrapedEntity:
    """Merge two entity records, disambiguating duplicates and pooling enrichment
    sources — confidence rises with multi-source confirmation."""
    title = target.title or source.get("title")
    seniority, department = classify_title(title)
    company = target.company or source.get("company") or ""

    sources = list(dict.fromkeys([*target.sources, *(source.get("sources") or [])]))
    confidence = max(target.confidence, source.get("confidence") or 0.5)
    if len(sources) >= 2:
        confidence = min(1.0, confidence + 0.15)

    source_email = source.get("email")
    return ScrapedEntity(
        name=target.name or source.get("name") or "",
        title=title,
        seniority=target.seniority or seniority,
        department=target.department or department,
        company=company,
        normalized_company=normalize_company_name(company),
        email=target.email or (source_email if is_valid_business_email(source_email) else None),
        domain=target.domain or source.get("domain"),
        linkedin_url=target.linkedin_url or source.get("linkedin_url"),
        phone=target.phone or source.get("phone"),
        location=target.location or source.get("location"),
        confidence=round(confidence, 2),
        sources=sources,
    )


async def cascade_enrich_entity(base: dict[str, Any], providers: list[EnrichmentProvider]) -> ScrapedEntity:
    """Run cascading enrichment across registered data providers, highest priority
    first, stopping early once email + LinkedIn + title are all confirmed."""
    sorted_providers = sorted(providers, key=lambda p: p.priority, reverse=True)
    base_email = base.get("email")
    entity = ScrapedEntity(
        name=base.get("name") or "", company=base.get("company") or "", title=base.get("title"),
        email=base_email if is_valid_business_email(base_email) else None,
        domain=base.get("domain"), linkedin_url=base.get("linkedin_url"),
        confidence=base.get("confidence") or 0.6,
        sources=base.get("sources") or ["initial_harvest"],
    )

    for provider in sorted_providers:
        if entity.email and entity.linkedin_url and entity.title:
            break
        try:
            enriched = await provider.enrich(entity)
            if enriched:
                entity = merge_entity_records(entity, {**enriched, "sources": [provider.name]})
        except Exception as err:
            logger.debug(f"effector cascade_enrich_entity: provider {provider.name} threw — {err}")

    return entity


_JSON_LD_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def extract_structured_data_from_html(html: str) -> list[dict[str, Any]]:
    """Extract JSON-LD / Microdata embedded structured entities (Person/ProfilePage)
    from raw page HTML — cheaper and more reliable than DOM scraping when the site
    already publishes structured data for SEO."""
    results: list[dict[str, Any]] = []
    for match in _JSON_LD_RE.finditer(html):
        try:
            parsed = json.loads(match.group(1))
        except Exception:
            continue
        items = parsed if isinstance(parsed, list) else [parsed]
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("@type") in ("Person", "ProfilePage"):
                email = item.get("email")
                works_for = item.get("worksFor") or {}
                results.append({
                    "name": item.get("name"),
                    "title": item.get("jobTitle"),
                    "company": works_for.get("name") if isinstance(works_for, dict) else None,
                    "email": email if is_valid_business_email(email) else None,
                    "linkedin_url": item.get("sameAs"),
                    "confidence": 0.9,
                    "sources": ["json_ld_schema"],
                })
    return results
