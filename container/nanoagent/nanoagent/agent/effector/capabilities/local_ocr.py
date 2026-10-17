"""Ported from computer-use/local-ocr.ts. Parses structured financial documents
entirely offline, zero bytes sent anywhere — a thin wrapper around
financial_extractor.py's arithmetic-invariant reconciler plus a couple of generic
metadata fields (invoice number, date, PO number) it doesn't otherwise extract."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from nanoagent.agent.effector.capabilities.financial_extractor import (
    ExtractedFinancialRecord,
    parse_invoice_text_with_invariants,
)

_INVOICE_META_RE = re.compile(r"\b(?:invoice|inv|bill)\s*(?:#|no\.?|num)?\s*[:\-]?\s*([A-Za-z0-9\-_]+)", re.IGNORECASE)
_DATE_META_RE = re.compile(r"\b(?:date|dated|invoice date)\s*[:\-]?\s*(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4})", re.IGNORECASE)
_PO_META_RE = re.compile(r"\b(?:po|p\.o\.|order)\s*(?:#|no\.?|num)?\s*[:\-]?\s*([A-Za-z0-9\-_]+)", re.IGNORECASE)


@dataclass
class LocalDocumentResult:
    doc_type: str  # 'invoice' | 'receipt' | 'table' | 'generic'
    fields: dict[str, Any] = field(default_factory=dict)
    is_compliant: bool = True
    warnings: list[str] = field(default_factory=list)
    reconciliation: ExtractedFinancialRecord | None = None


def parse_document_offline(raw_text: str) -> LocalDocumentResult:
    """Analyze a financial document's raw text with zero cloud calls — full data
    sovereignty (GDPR/HIPAA/SOC-2 relevant use cases)."""
    warnings: list[str] = []
    fields: dict[str, Any] = {}

    if m := _INVOICE_META_RE.search(raw_text):
        fields["invoice_number"] = m.group(1)
    if m := _DATE_META_RE.search(raw_text):
        fields["date"] = m.group(1)
    if m := _PO_META_RE.search(raw_text):
        fields["purchase_order"] = m.group(1)

    reconciliation: ExtractedFinancialRecord | None = None
    try:
        reconciliation = parse_invoice_text_with_invariants(raw_text)
    except Exception as err:
        warnings.append(f"Invoice arithmetic extraction failed: {err}")

    if reconciliation and not reconciliation.is_mathematically_balanced:
        warnings.append(
            f"Financial discrepancy detected: Subtotal ({reconciliation.subtotal}) + "
            f"Tax ({reconciliation.tax_amount}) != Total ({reconciliation.total_amount}) "
            f"[Diff: {reconciliation.balance_discrepancy}]"
        )

    is_compliant = reconciliation.is_mathematically_balanced if reconciliation else True

    logger.info(
        f"effector local-ocr: completed zero-cloud document analysis — "
        f"invoice_number={fields.get('invoice_number')} is_compliant={is_compliant} warnings={len(warnings)}"
    )

    return LocalDocumentResult(
        doc_type="invoice" if reconciliation else "generic",
        fields=fields, reconciliation=reconciliation,
        is_compliant=is_compliant, warnings=warnings,
    )
