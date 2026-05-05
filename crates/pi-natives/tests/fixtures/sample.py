"""Sample Python fixture for CodePath e2e tests."""

import functools


@functools.lru_cache(maxsize=128)
def cached_compute(n: int) -> int:
    """Compute something expensive."""
    return n * n


class Service:
    """A simple service class."""

    async def fetch(self, url: str) -> str:
        return f"data from {url}"

    @property
    def ready(self) -> bool:
        return True
