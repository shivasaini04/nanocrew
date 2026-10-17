"""The exec workspace guard must judge paths, not every token that starts with `/`.

One Mechanic cycle (2026-09-14) lost 6 of 12 exec calls to "path outside working dir",
and each retry was a new shape of the same command because the error never said which
token was the problem. The commands below are the real ones, trimmed to the part that
tripped the guard. The last group must stay blocked.
"""
import pytest

from nanoagent.agent.tools.shell import ExecTool

CWD = "/workspace/group"


@pytest.fixture
def guard():
    tool = ExecTool()
    tool.restrict_to_workspace = True
    return lambda cmd: tool._guard_command(cmd, CWD)


@pytest.mark.parametrize("cmd", [
    # a redirect target, with and without the shell's `;` stuck to it
    "find /workspace/group/workspace -maxdepth 2 -name package.json 2>/dev/null",
    "printenv PROJECT_BUILD_COMMAND >/dev/null 2>&1 && echo SET",
    "find /workspace/group/workspace -name '*.html' 2>/dev/null; echo done",
    # a JS regex literal inside node -e: the `>` of `<\/script>` then `/);`
    "node -e \"const m=html.match(/<script>([\\s\\S]*?)<\\/script>/);\ntry { new Function(m[1]); } catch (e) {}\"",
    "node -e \"x.match(/<script>([\\s\\S]*?)<\\/script>/);try{new Function(m[1]);console.log('JS OK')}catch(e){}\"",
    # the container's own scratch space
    "python3 -c \"open('/tmp/check-v2.js','w').write('x')\" && node /tmp/check-v2.js",
    # plainly inside the workspace
    "ls /workspace/group/workspace",
])
def test_harmless_commands_run(guard, cmd):
    assert guard(cmd) is None


@pytest.mark.parametrize("cmd", [
    "cat /etc/passwd",
    "cat /etc/passwd; echo hi",
    "ls /root",
    "cp notes.txt /home/someone/",
    "cat ../other-agent/secrets.json",
])
def test_real_outside_paths_stay_blocked(guard, cmd):
    assert guard(cmd) is not None
