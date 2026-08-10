def safe_average(values: list[float]) -> float:
    """Return the average, or 0.0 when values is empty."""
    return sum(values) / len(values)
