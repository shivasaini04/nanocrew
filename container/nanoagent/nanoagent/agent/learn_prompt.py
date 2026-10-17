"""``/learn`` — turn something the user points at into a reusable skill.

Stage 42 #7, ported in design from Hermes Agent's ``agent/learn_prompt.py``
(NousResearch/hermes-agent @ a7cd15e). Their key line, and the reason this file is
short::

    There is no separate distillation engine and no model-tool footprint: the agent
    does the work with its existing toolset.

So this module builds **one prompt** and hands it to the normal agent loop. The agent
gathers the sources with the tools it already has — ``read_file`` for a path,
``web`` for a URL, the conversation itself for "what we just did" — and writes the
result with ``save_skill``. Nothing new to maintain, and it works identically in a
chat turn and a background cycle.

It is the user-facing half of the learning loop: the post-turn review fork
(stage 42 #1) decides for itself what was worth keeping, while this is how a human
says *that — remember that.*
"""

from __future__ import annotations

# Authoring rules, kept in one place so the linter (stage 42 #6) and this prompt
# cannot drift apart. These mirror what skill_linter flags.
_STANDARDS = """\
Follow these rules when writing the skill:
- `name`: short, lowercase, hyphen-separated, and identical to what you pass to save_skill.
- `description`: one or two sentences saying WHEN to reach for this skill, not how good
  it is. This is the only text used to decide whether the skill gets loaded later, so
  make it specific and concrete. No marketing words.
- Body: the actual steps, commands, and gotchas — what you would want to re-read before
  attempting this again. Include the things that did NOT work and why, since that is the
  part nobody writes down and everybody rediscovers.
- Keep it to what you can state from the sources. Do not invent commands, flags or APIs
  you have not seen; a skill that confidently states something false is worse than no
  skill, because it will be trusted later."""


def build_learn_prompt(subject: str) -> str:
    """The prompt that makes the agent author a skill from whatever was named.

    ``subject`` is free-form, exactly as typed: a path, a URL, "the workflow we just
    went through", or pasted text.
    """
    subject = (subject or "").strip()

    if not subject:
        target = (
            "Look back over THIS conversation and identify the most reusable technique "
            "in it — something that worked, that you would want to repeat. If nothing "
            "here is worth keeping, say so plainly and write nothing; a skill written "
            "to look productive costs context on every future turn."
        )
    else:
        target = (
            f"What to learn: {subject}\n\n"
            "Work out for yourself what that refers to and gather it with the tools you "
            "already have — read_file or list_dir for a path, the web tools for a URL, "
            "this conversation for something we just did, or the text itself if it was "
            "pasted. If it is ambiguous, use `clarify` rather than guessing."
        )

    return (
        "Write a skill so you can do this again without relearning it.\n\n"
        f"{target}\n\n"
        f"{_STANDARDS}\n\n"
        "If a skill on this subject already exists, check it first with skill_search and "
        "UPDATE it under its exact name rather than creating a near-duplicate — two "
        "skills that half-cover the same ground are worse than one that covers it.\n\n"
        "For a large source (a book, a spec, a directory of docs), do not force it into "
        "one file: write a lean SKILL.md that indexes the material, and put the detail in "
        "`references/` files the skill points to, so only the index costs context.\n\n"
        "Finish by saying what you saved and why it will be useful."
    )


def parse_learn_command(content: str) -> str | None:
    """Extract the subject from a ``/learn`` message, or None if it isn't one.

    Returns "" for a bare ``/learn``, which means "learn from this conversation" —
    distinct from None, which means the message was not a learn command at all.
    """
    stripped = (content or "").strip()
    if not stripped.lower().startswith("/learn"):
        return None
    rest = stripped[len("/learn"):]
    if rest and not rest[0].isspace():
        return None  # e.g. "/learned something" is a sentence, not the command
    return rest.strip()
