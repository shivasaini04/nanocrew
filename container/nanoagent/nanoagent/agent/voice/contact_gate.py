"""
Contact Resolution Gate: Validates phone syntax, TRAI IST calling windows, and DND compliance.
"""
import re
import datetime
import pytz
from typing import Optional
from pydantic import BaseModel

class GateCheckResult(BaseModel):
    is_approved: bool
    phone_e164: str
    rejection_code: Optional[str] = None
    reason: Optional[str] = None

# Mock in-memory DND registry for prototype demonstration
DND_BLACKLIST = {"+919999999999", "+919888888888"}

def clean_and_validate_indian_phone(raw_phone: str) -> Optional[str]:
    """Cleans raw phone numbers and validates standard Indian +91 format (10-digits starting with 6-9)."""
    digits = re.sub(r"\D", "", str(raw_phone))
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    
    if len(digits) == 10 and digits[0] in "6789":
        return f"+91{digits}"
    return None

def is_trai_calling_hour() -> bool:
    """Verifies that current time in Asia/Kolkata is strictly between 09:00 and 21:00 IST."""
    now_ist = datetime.datetime.now(pytz.timezone("Asia/Kolkata"))
    return 9 <= now_ist.hour < 21

def run_contact_gate(raw_phone: str, bypass_time_check_for_dev: bool = False) -> GateCheckResult:
    """Executes the pre-call safety and compliance checks."""
    cleaned_phone = clean_and_validate_indian_phone(raw_phone)
    if not cleaned_phone:
        return GateCheckResult(
            is_approved=False,
            phone_e164="",
            rejection_code="INVALID_INDIAN_PHONE",
            reason="Phone number must be a valid 10-digit Indian mobile number."
        )

    # TRAI 9am - 9pm IST check
    if not bypass_time_check_for_dev and not is_trai_calling_hour():
        return GateCheckResult(
            is_approved=False,
            phone_e164=cleaned_phone,
            rejection_code="TRAI_HOURS_VIOLATION",
            reason="Outbound sales calls are legally restricted outside 09:00 AM - 09:00 PM IST."
        )

    # NDNC / DND check
    if cleaned_phone in DND_BLACKLIST:
        return GateCheckResult(
            is_approved=False,
            phone_e164=cleaned_phone,
            rejection_code="DND_REGISTERED",
            reason="Phone number is registered on National Do Not Call (NDNC) registry."
        )

    return GateCheckResult(is_approved=True, phone_e164=cleaned_phone)
