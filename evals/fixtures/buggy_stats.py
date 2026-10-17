import math


def moving_average(values, window):
    """Return the moving average for each full window of size `window`.

    moving_average([1, 2, 3, 4, 5], 3) -> [2.0, 3.0, 4.0]
    Raises ValueError if window <= 0.
    """
    if window <= 0:
        raise ValueError("window must be positive")
    result = []
    for i in range(len(values) - window):
        result.append(sum(values[i:i + window]) / window)
    return result


def normalize(values):
    """Min-max scale values into [0.0, 1.0].

    Constant input returns all zeros. Empty input returns [].
    normalize([0, 5, 10]) -> [0.0, 0.5, 1.0]
    """
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi == lo:
        return [0.0 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


def percentile(values, p):
    """Nearest-rank percentile, p in [0, 100]. `values` need not be sorted.

    percentile([1, 2, 3, 4, 5], 100) -> 5
    percentile([1, 2, 3, 4, 5], 0)   -> 1
    percentile([1, 2, 3, 4, 5], 50)  -> 3
    """
    if not values:
        raise ValueError("empty")
    s = sorted(values)
    k = round(p / 100 * len(s))
    return s[k]
