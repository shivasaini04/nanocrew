"""Autonomous Cloudflare Turnstile & Challenge Interaction Solver for Effector.

Detects interactive Cloudflare Turnstile, Arkose, and hCaptcha challenge checkboxes,
calculates organic human-kinetic approach coordinates, and manages settlement loops.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

from loguru import logger

from nanoagent.agent.effector.types import Point


class ChallengeSolver:
    """Detects and organically solves interactive Cloudflare Turnstile & hCaptcha widgets."""

    @staticmethod
    def compute_organic_click_point(box: dict[str, float]) -> Point:
        """Computes a randomized landing coordinate within the inner 35-65% zone of an element.

        Never clicks exact dead center (a strong bot signature) or boundary edges.
        """
        x_min = box["x"] + box["width"] * 0.35
        x_max = box["x"] + box["width"] * 0.65
        y_min = box["y"] + box["height"] * 0.35
        y_max = box["y"] + box["height"] * 0.65

        # Gaussian sampling biased towards the center-right/center-left of the checkbox
        rand_x = random.uniform(x_min, x_max)
        rand_y = random.uniform(y_min, y_max)
        return Point(x=round(rand_x, 1), y=round(rand_y, 1))

    @staticmethod
    async def find_interactive_challenge(page: Any) -> Any | None:
        """Locates interactive challenge iframes or checkbox targets."""
        try:
            # 1. Cloudflare Turnstile iframe
            if hasattr(page, "frame_locator"):
                turnstile_frame = page.frame_locator('iframe[src*="challenges.cloudflare.com"]')
                checkbox = turnstile_frame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, #challenge-stage input')
                if await checkbox.count() > 0 and await checkbox.first.is_visible():
                    return checkbox.first

                # 2. hCaptcha iframe
                hcaptcha_frame = page.frame_locator('iframe[src*="hcaptcha.com"]')
                h_checkbox = hcaptcha_frame.locator('#checkbox, .check, input[type="checkbox"]')
                if await h_checkbox.count() > 0 and await h_checkbox.first.is_visible():
                    return h_checkbox.first

            # 3. Direct DOM challenge checkbox (non-iframe or same-origin)
            if hasattr(page, "locator"):
                direct_selectors = [
                    '#challenge-stage input[type="checkbox"]',
                    '.ctp-checkbox-label',
                    '#cf-turnstile-wrapper input',
                    'input[name="cf-turnstile-response"]',
                ]
                for selector in direct_selectors:
                    loc = page.locator(selector)
                    if await loc.count() > 0 and await loc.first.is_visible():
                        return loc.first
        except Exception as err:
            logger.debug(f"challenge_solver: error during challenge discovery ({err})")

        return None

    @classmethod
    async def solve_if_present(cls, page: Any, timeout_s: float = 10.0) -> bool:
        """Attempts organic kinetic interaction with challenge widgets if present."""
        target = await cls.find_interactive_challenge(page)
        if target is None:
            return False

        logger.info("challenge_solver: detected interactive challenge widget — beginning kinetic solve")
        try:
            box = await target.bounding_box()
            if not box:
                return False

            click_point = cls.compute_organic_click_point(box)

            # Human gaze dwell before initiating mouse movement
            await asyncio.sleep(random.uniform(0.25, 0.65))

            # Move mouse using Playwright mouse interface if available
            if hasattr(page, "mouse"):
                await page.mouse.move(click_point.x, click_point.y, steps=random.randint(14, 22))
                await asyncio.sleep(random.uniform(0.12, 0.35))
                await page.mouse.down()
                await asyncio.sleep(random.uniform(0.06, 0.12))
                await page.mouse.up()
            elif hasattr(target, "click"):
                await target.click()

            # Settlement polling: wait for clearance cookie or element disappearance
            deadline = asyncio.get_event_loop().time() + timeout_s
            while asyncio.get_event_loop().time() < deadline:
                await asyncio.sleep(0.5)
                # If element is gone or hidden, challenge passed
                try:
                    if await target.count() == 0 or not await target.is_visible():
                        logger.info("challenge_solver: challenge solved successfully (element cleared)")
                        return True
                except Exception:
                    return True

            logger.warning("challenge_solver: timed out waiting for challenge settlement")
            return False
        except Exception as err:
            logger.warning(f"challenge_solver: solve cycle failed with error ({err})")
            return False
