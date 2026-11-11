"""
Stage 5 inference priority — pure, no torch/weights.

One inference thread serves both lanes. A `kind=query` request jumps ahead
of the next waiting passage batch (including when query and passage hit the
same endpoint): interactive search never waits behind a corpus tail.

The class below is the ordering core the service thread uses. It is pure
(heap + counter) so the contract is testable without loading the model:
queries win by priority, FIFO is preserved inside each lane.
"""

from __future__ import annotations

import heapq
import itertools


class PrioritySchedule:
    """Priority queue where query (0) beats passage (1), FIFO inside a lane."""

    def __init__(self) -> None:
        self._heap: list[tuple[int, int, str, object]] = []
        self._seq = itertools.count()

    @staticmethod
    def _priority(kind: str) -> int:
        return 0 if kind == "query" else 1

    def push(self, kind: str, payload: object = None) -> int:
        """Enqueue one job; returns its arrival sequence (for debugging)."""
        seq = next(self._seq)
        heapq.heappush(self._heap, (self._priority(kind), seq, kind, payload))
        return seq

    def pop(self) -> tuple[str, object]:
        """Next job: (kind, payload). Raises IndexError when empty."""
        _, _, kind, payload = heapq.heappop(self._heap)
        return kind, payload

    def peek_kind(self) -> str | None:
        """Kind of the job that would run next, without removing it."""
        if not self._heap:
            return None
        return self._heap[0][2]

    def __len__(self) -> int:
        return len(self._heap)

    def __bool__(self) -> bool:
        return bool(self._heap)
