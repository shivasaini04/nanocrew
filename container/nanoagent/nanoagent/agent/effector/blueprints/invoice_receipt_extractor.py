"""Ported from computer-use/blueprints/invoice-receipt-extractor.ts. Turnkey
invoice/expense-portal extraction blueprint."""

from __future__ import annotations

from dataclasses import dataclass, field

from nanoagent.agent.effector.blueprints.runner import BlueprintContext, _run_goal
from nanoagent.agent.effector.types import EffectorExecutionResult


@dataclass
class InvoiceExtractorConfig:
    portal_url: str | None = None
    target_software: str | None = None  # 'quickbooks' | 'xero' | 'expensify' | 'generic'
    currency: str | None = None


@dataclass
class InvoiceRecord:
    invoice_number: str | None = None
    vendor_name: str | None = None
    amount: float | None = None
    date: str | None = None
    status: str | None = None


@dataclass
class InvoiceExtractorResult:
    invoices_processed: list[dict] = field(default_factory=list)
    execution: EffectorExecutionResult | None = None


async def run_invoice_extractor(config: InvoiceExtractorConfig, ctx: BlueprintContext) -> InvoiceExtractorResult:
    portal_clause = f' at "{config.portal_url}"' if config.portal_url else ""

    goal = (
        f"Open invoice portal{portal_clause}.\n"
        f"1. Locate pending unbilled or unpaid invoices.\n"
        f"2. For each invoice, extract invoice number, vendor name, invoice date, and total balance.\n"
        f"3. Verify totals and return structured records."
    )

    execution = await _run_goal(ctx, goal, url=config.portal_url, session_domain=None, max_turns=15)

    invoices = (execution.extracted_data or {}).get("invoices") or []
    return InvoiceExtractorResult(invoices_processed=invoices, execution=execution)
