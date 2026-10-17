"""error_classifier — classify tool errors and provide structured recovery hints."""

from __future__ import annotations

from enum import Enum


class ErrorClass(Enum):
    TRANSIENT   = "transient"
    NOT_FOUND   = "not_found"
    PERMISSION  = "permission"
    CONFIG      = "config"
    RATE_LIMIT  = "rate_limit"
    TIMEOUT     = "timeout"
    UNKNOWN     = "unknown"


RECOVERY_HINTS: dict[ErrorClass, str] = {
    ErrorClass.TRANSIENT:  "This appears to be a temporary network issue. Wait a moment and try again, or use an alternative approach.",
    ErrorClass.NOT_FOUND:  "The file or resource was not found. Verify the path exists, or create the resource first.",
    ErrorClass.PERMISSION: "Access was denied. Write operations must target /workspace/group/workspace/ — check your path.",
    ErrorClass.CONFIG:     "A required credential or API key is missing for this tool. Skip this step or use an alternative.",
    ErrorClass.RATE_LIMIT: "You have hit a rate limit. Wait before retrying, or switch to a different data source.",
    ErrorClass.TIMEOUT:    "The operation timed out. Try with a smaller/simpler request, or break the task into steps.",
    ErrorClass.UNKNOWN:    "An unexpected error occurred. Try a different approach or skip this step.",
}

# Which classes warrant automatic retry
SHOULD_RETRY: dict[ErrorClass, bool] = {
    ErrorClass.TRANSIENT:  True,
    ErrorClass.RATE_LIMIT: True,
    ErrorClass.TIMEOUT:    True,
    ErrorClass.NOT_FOUND:  False,
    ErrorClass.PERMISSION: False,
    ErrorClass.CONFIG:     False,
    ErrorClass.UNKNOWN:    False,
}


def classify_error(tool_name: str, error: Exception | str) -> ErrorClass:
    """Classify an error based on its message text."""
    msg = str(error).lower()

    if any(x in msg for x in ["timed out", "timeout", "read timeout", "connect timeout"]):
        return ErrorClass.TIMEOUT
    if any(x in msg for x in ["rate limit", "ratelimit", "429", "too many requests", "quota exceeded", "slowdown"]):
        return ErrorClass.RATE_LIMIT
    if any(x in msg for x in ["connection reset", "connection refused", "network unreachable",
                                "temporary failure", "name resolution", "ssl", "certificate",
                                "eof occurred", "broken pipe"]):
        return ErrorClass.TRANSIENT
    if any(x in msg for x in ["no such file", "not found", "filenotfounderror",
                                "does not exist", "no such path", "404", "enoent"]):
        return ErrorClass.NOT_FOUND
    if any(x in msg for x in ["permission denied", "access denied", "forbidden",
                                "not permitted", "401", "403", "eperm", "eacces"]):
        return ErrorClass.PERMISSION
    if any(x in msg for x in ["api key", "api_key", "authentication", "unauthorized",
                                "invalid key", "invalid token", "credentials", "auth failed"]):
        return ErrorClass.CONFIG

    return ErrorClass.UNKNOWN
