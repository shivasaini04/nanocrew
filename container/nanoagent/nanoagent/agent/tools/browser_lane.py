"""Which browser a call gets, once the operator has chosen (stage 60 phase 1).

Stage 52 made the lane a per-call choice by the MODEL: ``identity='anonymous'`` for the
container, ``'me'`` for the user's own browser. The chat now has a picker under the
message box, and when the operator uses it their choice is the answer, not the model's:

    NC_BROWSER_LANE=local   every browser call goes to their browser ('me')
    NC_BROWSER_LANE=cloud   every browser call stays in the container; 'me' is refused
    unset                   the model's ``identity`` decides, exactly as before

Both ``browser`` and ``effector`` resolve through here so they cannot disagree.
"""

from __future__ import annotations

import os


def chosen_lane() -> str | None:
    """'local' | 'cloud' when the operator picked one for this message, else None."""
    lane = os.environ.get("NC_BROWSER_LANE", "").strip().lower()
    return lane if lane in ("local", "cloud") else None


def resolve_identity(requested: object) -> str:
    """The identity a call actually runs as: 'me' or 'anonymous'."""
    lane = chosen_lane()
    if lane == "local":
        return "me"
    return "me" if str(requested or "anonymous").strip().lower() == "me" else "anonymous"


def not_connected_message() -> str:
    """What to tell the model when 'me' was asked for and there is no browser to use."""
    if chosen_lane() == "cloud":
        return (
            "The user chose the Cloud browser for this message, so their own signed-in "
            "browser is not available. If this step really needs their account, tell them "
            "and ask them to switch the browser picker under the message box to This "
            "computer. Do not retry as 'anonymous' for something that must come from them."
        )
    return (
        "This step asked to act as the user ('me'), but their browser is not connected. "
        "Ask them to open the NanoCrew desktop app, then retry. Do not fall back to "
        "'anonymous' — that would act as nobody instead."
    )
