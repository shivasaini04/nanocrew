# Repro test handed to the agent. It reveals ONE symptom (moving_average drops
# the final window). The agent should run this, find the cause, and audit the
# rest of the module for related issues — the hidden suite checks more.
from stats import moving_average


def test_moving_average_includes_final_window():
    assert moving_average([1, 2, 3, 4, 5], 3) == [2.0, 3.0, 4.0]
