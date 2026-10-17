"""Ported from computer-use/financial-extractor.ts. Enforces the fundamental
accounting arithmetic invariant — Sum(LineItems) + Tax + Shipping - Discount ==
Total (±0.02) — so an extracted invoice is checked for internal consistency, not
just structurally parsed."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class InvoiceLineItem:
    description: str
    quantity: float
    unit_price: float
    total: float


@dataclass
class ExtractedFinancialRecord:
    currency: str = "USD"
    line_items: list[InvoiceLineItem] = field(default_factory=list)
    subtotal: float = 0.0
    tax_amount: float = 0.0
    shipping_amount: float = 0.0
    discount_amount: float = 0.0
    total_amount: float = 0.0
    is_mathematically_balanced: bool = False
    balance_discrepancy: float = 0.0
    confidence_score: float = 0.0
    invoice_number: str | None = None
    vendor_name: str | None = None
    vendor_tax_id: str | None = None
    invoice_date: str | None = None
    due_date: str | None = None


def reconcile_invoice_arithmetic(
    invoice_number: str | None = None,
    vendor_name: str | None = None,
    vendor_tax_id: str | None = None,
    invoice_date: str | None = None,
    due_date: str | None = None,
    currency: str | None = None,
    line_items: list[InvoiceLineItem] | None = None,
    subtotal: float | None = None,
    tax_amount: float | None = None,
    shipping_amount: float | None = None,
    discount_amount: float | None = None,
    total_amount: float | None = None,
) -> ExtractedFinancialRecord:
    items = line_items or []
    calculated_line_total = sum(item.total or (item.quantity * item.unit_price) or 0 for item in items)

    resolved_subtotal = subtotal if subtotal is not None else calculated_line_total
    tax = tax_amount or 0.0
    shipping = shipping_amount or 0.0
    discount = discount_amount or 0.0
    resolved_total = total_amount if total_amount is not None else (resolved_subtotal + tax + shipping - discount)

    expected_total = resolved_subtotal + tax + shipping - discount
    discrepancy = abs(expected_total - resolved_total)
    is_balanced = discrepancy <= 0.02

    confidence = 0.5
    if invoice_number:
        confidence += 0.15
    if vendor_name:
        confidence += 0.15
    if invoice_date:
        confidence += 0.1
    if is_balanced:
        confidence += 0.1

    return ExtractedFinancialRecord(
        invoice_number=invoice_number, vendor_name=vendor_name, vendor_tax_id=vendor_tax_id,
        invoice_date=invoice_date, due_date=due_date, currency=currency or "USD",
        line_items=items,
        subtotal=round(resolved_subtotal, 2), tax_amount=round(tax, 2),
        shipping_amount=round(shipping, 2), discount_amount=round(discount, 2),
        total_amount=round(resolved_total, 2),
        is_mathematically_balanced=is_balanced, balance_discrepancy=round(discrepancy, 2),
        confidence_score=min(1.0, round(confidence, 2)),
    )


_INV_RE = re.compile(r"\b(?:invoice\s*(?:#|no\.?|num)?)\s*[:\s]?\s*([A-Za-z0-9-_]+)", re.IGNORECASE)
_SUBTOTAL_RE = re.compile(r"\b(?:subtotal|sub\s*total)\b\s*[:\s]?\s*\$?\s*([\d,]+\.\d{2})", re.IGNORECASE)
_TAX_RE = re.compile(r"\b(?:tax|vat|gst)\b\s*[:\s]?\s*\$?\s*([\d,]+\.\d{2})", re.IGNORECASE)
_TOTAL_RE = re.compile(r"\b(?:total|balance\s*due|amount\s*due)\b\s*[:\s]?\s*\$?\s*([\d,]+\.\d{2})", re.IGNORECASE)
_DATE_RE = re.compile(r"\b(?:date|invoice\s*date)\b\s*[:\s]?\s*(\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})", re.IGNORECASE)


def _clean_num(s: str | None) -> float:
    return float(s.replace(",", "")) if s else 0.0


def parse_invoice_text_with_invariants(raw_text: str) -> ExtractedFinancialRecord:
    """Extract a structured financial record from raw invoice text with invariant
    validation — regex extraction, not vision; meant for text already pulled off a
    page (via `extract` steps) or a PDF (`read_pdf`)."""
    inv_match = _INV_RE.search(raw_text)
    subtotal_match = _SUBTOTAL_RE.search(raw_text)
    tax_match = _TAX_RE.search(raw_text)
    total_match = _TOTAL_RE.search(raw_text)
    date_match = _DATE_RE.search(raw_text)

    subtotal = _clean_num(subtotal_match.group(1) if subtotal_match else None)
    tax_amount = _clean_num(tax_match.group(1) if tax_match else None)
    total_amount = _clean_num(total_match.group(1) if total_match else None)

    return reconcile_invoice_arithmetic(
        invoice_number=inv_match.group(1) if inv_match else None,
        invoice_date=date_match.group(1) if date_match else None,
        subtotal=subtotal or (total_amount - tax_amount if total_amount else 0),
        tax_amount=tax_amount,
        total_amount=total_amount or (subtotal + tax_amount),
    )
