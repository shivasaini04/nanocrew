"""The live screen, started when someone takes the wheel (stage 50 phase 5).

Two pieces already exist and neither is useful alone: `desktop/vnc_session.py` serves the
X display over RFB, and `vnc_relay.py` carries those bytes out of a container nothing can
connect to. This is the thing that turns them on together, in the right order, and — the
part that actually matters — turns them off again.

## Why it is not simply always on

A VNC session costs CPU in the container and bandwidth all the way to the dashboard, for
as long as it is open. Watching an agent work does not need it: the once-a-second
screenshot is enough to see what is happening, and it is what every lane can do. The live
screen is for when a person is actually driving, which is rare, short, and exactly when
smoothness is worth paying for.

So this starts on takeover and stops on hand-back.

## Why stopping is the risky half

`NANOBOT_PERSISTENT=on` keeps one container warm across many cycles. Anything left
running at the end of a run is still running at the start of the next one — and here that
would mean an x11vnc holding a display, and a relay socket authenticated with a token
that has since been revoked. `xvfb_session.py` records being bitten by this shape twice.
`stop()` is therefore idempotent, safe on a path that runs twice, and called from the
takeover's `finally` rather than from its happy path.

## It never fails a run

Every step degrades: no display (the remote lane drives the user's own browser, and there
is no container screen to serve), no x11vnc on the image, an orchestrator that will not
take the socket. All of them mean the person drives the screenshot instead, which still
works. None of them raise.
"""

from __future__ import annotations

from typing import Any

from loguru import logger


class LiveScreen:
    """x11vnc plus a relay, as one thing that can be switched on and off."""

    def __init__(self, display: str | None):
        self._display = display
        self._relay: Any = None
        self._on = False

    @property
    def running(self) -> bool:
        return self._on

    async def start(self) -> bool:
        """Serve the screen and carry it out. False means "watch the screenshots"."""
        if self._on:
            return True
        if not self._display:
            # The remote lane: the browser is on someone's own machine and there is no
            # container display to serve. Not a fault, and not worth a warning on every
            # takeover in that lane.
            logger.debug("effector: no display on this lane — no live screen")
            return False

        from nanoagent.agent.effector.desktop import vnc_session
        from nanoagent.agent.effector.vnc_relay import VncRelay

        port = vnc_session.start(self._display)
        if not port:
            return False

        relay = VncRelay.from_env(port)
        if relay is None:
            # Not inside a real cycle, so there is no token to authenticate with and
            # nowhere to dial. Leave nothing running behind us.
            vnc_session.stop()
            return False

        if not await relay.start():
            vnc_session.stop()
            return False

        self._relay = relay
        self._on = True
        logger.info("effector: live screen up")
        return True

    async def stop(self) -> None:
        """Idempotent. Runs on a teardown path, so it must never raise."""
        from nanoagent.agent.effector.desktop import vnc_session

        relay, self._relay = self._relay, None
        if relay is not None:
            try:
                await relay.stop()
            except Exception as err:  # noqa: BLE001
                logger.debug(f"effector: live screen relay would not stop cleanly — {err}")
        try:
            vnc_session.stop()
        except Exception as err:  # noqa: BLE001
            logger.debug(f"effector: x11vnc would not stop cleanly — {err}")
        if self._on:
            logger.info("effector: live screen down")
        self._on = False
