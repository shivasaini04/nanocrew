# Ground-truth test suite for the engineer-coding eval case.
# The agent never sees these cases — they are run independently by the harness
# against the agent's solution.py to give a bias-free correctness score.
from solution import merge_intervals as m


def test_basic():
    assert m([[1, 3], [2, 6], [8, 10], [15, 18]]) == [[1, 6], [8, 10], [15, 18]]


def test_unsorted_input():
    # naive left-to-right merges fail if they assume sorted input
    assert m([[8, 10], [1, 3], [2, 6]]) == [[1, 6], [8, 10]]


def test_touching_intervals():
    # [1,2] and [2,3] touch at 2 — should merge to [1,3]
    assert m([[1, 2], [2, 3]]) == [[1, 3]]


def test_fully_contained():
    assert m([[1, 10], [2, 5]]) == [[1, 10]]


def test_single():
    assert m([[5, 7]]) == [[5, 7]]


def test_empty():
    assert m([]) == []


def test_duplicates():
    assert m([[1, 4], [1, 4]]) == [[1, 4]]


def test_no_overlap_reverse_order():
    assert m([[15, 18], [8, 10], [1, 3]]) == [[1, 3], [8, 10], [15, 18]]


def test_chain_merge():
    # cascading overlaps that all collapse into one
    assert m([[1, 4], [3, 6], [5, 8], [7, 10]]) == [[1, 10]]


def test_negative_values():
    assert m([[-5, -1], [-3, 2], [4, 6]]) == [[-5, 2], [4, 6]]
