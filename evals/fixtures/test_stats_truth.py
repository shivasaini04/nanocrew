# Hidden ground-truth suite for the engineer-bugfix case. The agent never sees
# these. Covers BOTH planted bugs (moving_average off-by-one; percentile
# round-vs-nearest-rank, which IndexErrors at p=100) plus a regression guard on
# normalize (which is already correct and must stay correct).
import pytest
from stats import moving_average, normalize, percentile


# --- moving_average (planted bug #1: dropped final window) ---
def test_ma_basic():
    assert moving_average([1, 2, 3, 4, 5], 3) == [2.0, 3.0, 4.0]


def test_ma_window_one():
    assert moving_average([4, 8, 15], 1) == [4.0, 8.0, 15.0]


def test_ma_full_window():
    assert moving_average([2, 4, 6], 3) == [4.0]


def test_ma_invalid_window():
    with pytest.raises(ValueError):
        moving_average([1, 2], 0)


# --- normalize (already correct — regression guard) ---
def test_norm_basic():
    assert normalize([0, 5, 10]) == [0.0, 0.5, 1.0]


def test_norm_constant():
    assert normalize([3, 3, 3]) == [0.0, 0.0, 0.0]


def test_norm_empty():
    assert normalize([]) == []


# --- percentile (planted bug #2: only revealed by p=100 / boundaries) ---
def test_pct_max():
    assert percentile([1, 2, 3, 4, 5], 100) == 5


def test_pct_min():
    assert percentile([1, 2, 3, 4, 5], 0) == 1


def test_pct_mid():
    assert percentile([1, 2, 3, 4, 5], 50) == 3


def test_pct_unsorted_max():
    assert percentile([5, 1, 3, 2, 4], 100) == 5
