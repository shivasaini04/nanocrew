"""The agent reviews its own turn — under tight constraints, or not at all.

Stage 42 item #1, the fast learning loop. ``self_improve`` already existed as a
weekly *cycle* that distils memory and rewrites IDENTITY.md; it has never written a
skill, and it works from a summary rather than the trace.

This runs after each turn, from the actual transcript. Because it writes
autonomously, the constraints are the feature and are what these tests defend:

  * everything it writes is tagged ``background_review``, so a curator can later
    tell its output from the user's — the reason stage 42 #2 had to land first;
  * it can only reach memory and skill tools, by omission rather than by policy;
  * it is off unless switched on, one at a time per session, and silent on failure.
"""
import asyncio

import pytest

# background_review logs through loguru, so this module needs the full agent
# runtime. Skips on a bare checkout, runs in the container — same posture as
# tests/test_truncated_response.py.
pytest.importorskip("loguru", reason="needs the full agent runtime (container image)")

from nanoagent.agent import background_review, skill_origins  # noqa: E402
from nanoagent.agent.background_review import (  # noqa: E402
    BackgroundReviewer,
    build_review_registry,
)
from nanoagent.agent.tool_origin import BACKGROUND_REVIEW, DEFAULT_ORIGIN  # noqa: E402
from nanoagent.agent.tools.base import Tool  # noqa: E402
from nanoagent.agent.tools.registry import ToolRegistry  # noqa: E402
from nanoagent.agent.tools.save_skill import SaveSkillTool  # noqa: E402


class Recorder(Tool):
    """Stands in for a tool the fork must not be able to reach."""

    def __init__(self, name="exec"):
        self._name = name
        self.calls = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "dangerous"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}, "required": []}

    async def execute(self, **kwargs) -> str:
        self.calls += 1
        return "ran"


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv(background_review.ENV_FLAG, "on")


@pytest.fixture
def workspace(tmp_path):
    (tmp_path / "skills").mkdir()
    return tmp_path


class FakeProvider:
    """Scripted provider; records the model it was asked for."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.models_used = []

    async def chat(self, messages, tools=None, model=None, **kwargs):
        self.models_used.append(model)
        return self._responses.pop(0)


class FakeLoop:
    def __init__(self, tools, provider, model="cfg/default"):
        self.tools = tools
        self.provider = provider
        self.model = model


def response(content=None, tool_calls=()):
    from nanoagent.providers.base import LLMResponse

    return LLMResponse(content=content, tool_calls=list(tool_calls))


def call(name, args, cid="c1"):
    from nanoagent.providers.base import ToolCallRequest

    return ToolCallRequest(id=cid, name=name, arguments=args)


# ─── the whitelist ──────────────────────────────────────────────────────────


def test_the_fork_can_only_reach_memory_and_skill_tools(workspace):
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    source.register(Recorder("exec"))
    source.register(Recorder("smtp_send"))

    restricted = build_review_registry(source)

    assert "save_skill" in restricted
    assert "exec" not in restricted, "denial is by omission, not by policy"
    assert "smtp_send" not in restricted


def test_the_forks_registry_is_tagged_as_agent_created(workspace):
    restricted = build_review_registry(ToolRegistry())

    assert restricted.write_origin == BACKGROUND_REVIEW


async def test_what_the_fork_writes_is_marked_agent_created(workspace, enabled):
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    provider = FakeProvider([
        response(tool_calls=[call("save_skill", {"name": "yc-sweep", "content": "# body"})]),
        response(content="Saved one skill."),
    ])

    reviewer = BackgroundReviewer(FakeLoop(source, provider))
    await reviewer.spawn("s1", [{"role": "user", "content": "how do YC sweeps work?"}])

    assert skill_origins.is_agent_created_skill(workspace, "yc-sweep")
    assert skill_origins.get_origin(workspace, "yc-sweep") == BACKGROUND_REVIEW


async def test_a_foreground_save_is_still_user_owned(workspace, enabled):
    """The fork's tagging must not leak onto ordinary tool use."""
    foreground = ToolRegistry()
    foreground.register(SaveSkillTool(workspace))

    await foreground.execute("save_skill", {"name": "dictated", "content": "# body"})

    assert skill_origins.get_origin(workspace, "dictated") == DEFAULT_ORIGIN


# ─── when it runs ───────────────────────────────────────────────────────────


def test_it_is_off_unless_switched_on(workspace, monkeypatch):
    monkeypatch.delenv(background_review.ENV_FLAG, raising=False)
    reviewer = BackgroundReviewer(FakeLoop(ToolRegistry(), FakeProvider([])))

    assert reviewer.spawn("s1", [{"role": "user", "content": "hi"}]) is None


def test_an_empty_turn_is_not_reviewed(workspace, enabled):
    reviewer = BackgroundReviewer(FakeLoop(ToolRegistry(), FakeProvider([])))

    assert reviewer.spawn("s1", []) is None


async def test_only_one_review_per_session_at_a_time(workspace, enabled):
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    started = asyncio.Event()
    release = asyncio.Event()

    class Slow(FakeProvider):
        async def chat(self, *a, **k):
            started.set()
            await release.wait()
            return response(content="done")

    reviewer = BackgroundReviewer(FakeLoop(source, Slow([])))
    first = reviewer.spawn("s1", [{"role": "user", "content": "one"}])
    await started.wait()

    assert reviewer.spawn("s1", [{"role": "user", "content": "two"}]) is None

    release.set()
    await first


async def test_a_failing_review_never_surfaces(workspace, enabled):
    """A turn that already succeeded must not be retroactively broken."""

    class Exploding(FakeProvider):
        async def chat(self, *a, **k):
            raise RuntimeError("provider down")

    reviewer = BackgroundReviewer(FakeLoop(ToolRegistry(), Exploding([])))
    reviewer._loop.tools.register(SaveSkillTool(workspace))

    result = await reviewer.spawn("s1", [{"role": "user", "content": "hi"}])

    assert result is None


async def test_it_stops_after_a_bounded_number_of_rounds(workspace, enabled):
    """A fork that kept calling tools would be an unbounded background spend."""
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    forever = [
        response(tool_calls=[call("save_skill", {"name": f"s{i}", "content": "x"})])
        for i in range(50)
    ]
    provider = FakeProvider(forever)

    reviewer = BackgroundReviewer(FakeLoop(source, provider))
    await reviewer.spawn("s1", [{"role": "user", "content": "hi"}])

    assert len(provider.models_used) == background_review.MAX_REVIEW_ITERATIONS


# ─── staying alive long enough to write ─────────────────────────────────────
#
# Every test above awaits the task spawn() returns, which is not what production
# does. spawn() is fire-and-forget and the process that called it goes away at the
# end of the turn, so the review has to be drained explicitly or it is cancelled
# mid-flight and writes nothing. That is not hypothetical: it is why the flag ran
# on Mailer for 13h across ~10 cycles and produced zero skills.


async def test_a_spawned_review_is_lost_without_a_drain(workspace, enabled):
    """The failure this drain exists to prevent, reproduced.

    Nothing awaits the task, the caller finishes its work, and the review is still
    only partway through its rounds — exactly the shape of a cycle ending.
    """
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    gate = asyncio.Event()

    class SlowProvider(FakeProvider):
        async def chat(self, messages, tools=None, model=None, **kwargs):
            await gate.wait()  # stands in for a model round-trip in progress
            return await super().chat(messages, tools=tools, model=model, **kwargs)

    provider = SlowProvider([
        response(tool_calls=[call("save_skill", {"name": "learned", "content": "x"})]),
        response(content="saved"),
    ])
    reviewer = BackgroundReviewer(FakeLoop(source, provider))

    task = reviewer.spawn("s1", [{"role": "user", "content": "hi"}])
    await asyncio.sleep(0)  # let it start, as an in-flight review would be

    task.cancel()  # what asyncio.run() does to pending tasks at process exit
    await asyncio.gather(task, return_exceptions=True)

    assert not (workspace / "skills" / "learned").exists()


async def test_drain_lets_an_in_flight_review_finish_writing(workspace, enabled):
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    provider = FakeProvider([
        response(tool_calls=[call("save_skill", {"name": "learned", "content": "x"})]),
        response(content="saved"),
    ])
    reviewer = BackgroundReviewer(FakeLoop(source, provider))

    reviewer.spawn("s1", [{"role": "user", "content": "hi"}])
    assert reviewer.pending == 1
    assert await reviewer.drain() is True

    assert (workspace / "skills" / "learned" / "SKILL.md").exists()
    assert reviewer.pending == 0


async def test_drain_on_nothing_is_a_no_op(workspace, enabled):
    """asyncio.wait() raises on an empty set, so the guard is load-bearing."""
    reviewer = BackgroundReviewer(FakeLoop(ToolRegistry(), FakeProvider([])))

    assert await reviewer.drain() is True


async def test_drain_cancels_a_review_that_overruns(workspace, enabled):
    """A hung review must not hold a cycle's container open indefinitely."""
    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))

    class HangingProvider(FakeProvider):
        async def chat(self, messages, tools=None, model=None, **kwargs):
            await asyncio.sleep(3600)

    reviewer = BackgroundReviewer(FakeLoop(source, HangingProvider([])))
    task = reviewer.spawn("s1", [{"role": "user", "content": "hi"}])

    assert await reviewer.drain(timeout=0.05) is False
    assert task.cancelled() or task.done()


async def test_drain_reports_success_even_when_the_review_itself_failed(workspace, enabled):
    """Drain answers "did they finish", not "did they succeed"."""
    class Boom(FakeProvider):
        async def chat(self, *a, **k):
            raise RuntimeError("provider down")

    source = ToolRegistry()
    source.register(SaveSkillTool(workspace))
    reviewer = BackgroundReviewer(FakeLoop(source, Boom([])))

    reviewer.spawn("s1", [{"role": "user", "content": "hi"}])

    assert await reviewer.drain() is True


def test_the_drain_bound_is_configurable(monkeypatch):
    monkeypatch.setenv(background_review.ENV_DRAIN_TIMEOUT, "12.5")
    assert background_review.drain_timeout() == 12.5

    # A nonsense value falls back rather than crashing a cycle at teardown.
    monkeypatch.setenv(background_review.ENV_DRAIN_TIMEOUT, "soon")
    assert background_review.drain_timeout() == background_review.DRAIN_TIMEOUT_SECONDS

    monkeypatch.setenv(background_review.ENV_DRAIN_TIMEOUT, "-5")
    assert background_review.drain_timeout() == background_review.DRAIN_TIMEOUT_SECONDS


# ─── the snapshot ───────────────────────────────────────────────────────────


def test_the_snapshot_keeps_the_end_of_the_turn():
    """The answer and the tool results that produced it carry the lesson."""
    turn = [{"role": "user", "content": "x" * 20_000},
            {"role": "assistant", "content": "THE CONCLUSION"}]

    snapshot = background_review.build_snapshot(turn, limit=1_000)

    assert "THE CONCLUSION" in snapshot
    assert len(snapshot) < 1_200
    assert "trimmed" in snapshot


def test_structured_content_blocks_are_flattened():
    turn = [{"role": "assistant", "content": [{"type": "text", "text": "hello"}]}]

    assert "hello" in background_review.build_snapshot(turn)


def test_empty_messages_are_dropped():
    turn = [{"role": "assistant", "content": ""}, {"role": "user", "content": "real"}]

    assert background_review.build_snapshot(turn) == "[user] real"
