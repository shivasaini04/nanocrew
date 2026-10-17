# Frame fixture — random tokens inside real cross-origin frames

Replaces the demoqa.com pages tier tests 3.3 and 3.4 used. Those tests were voided on
2026-08-29: every string they asked for is famous enough that a model can produce it from
memory, so both returned correct answers with the frame mechanism bypassed. See
`docs/research/digital-employee-engine/test/03-hard.md` → *Correction*.

## Shape

```
parent.html        localhost:PORT      #parent-input, token PT-xxxxxxxx
  └─ iframe        127.0.0.1:PORT      child.html — cross-origin from the parent
       button#claim   "Claim CT-xxxxxxxx"   ← the control the test is about
       input#child-input
       └─ iframe   localhost:PORT      grandchild.html — cross-origin again, depth 2
            input#deep-input placeholder DT-xxxxxxxx
```

Both boundaries are genuine origin boundaries (the hostname differs), so nothing passes by
same-origin accident.

## Why a button, not text

A valid frame test needs in-frame content that is **interactive** (perception has to reach
it) and **unguessable** (recall cannot). Clicking `#claim` writes
`CLAIMED CT-xxxxxxxx trusted=<isTrusted>` into the frame, which the harness reads off the
page — so a pass means the click actually landed, in the frame, at coordinates something
computed. `trusted=true` additionally separates the CDP input path from synthetic events,
which arrive with `isTrusted=false`.

## Use

```bash
python serve.py --port 8917      # prints one JSON line, then serves
```

or from a test:

```python
from tests.fixtures.frames.serve import serve

httpd, described = serve(8917)
token = described["tokens"]["child"]
...
httpd.shutdown()
```
