"""Sample Python module for the outline tests (and the mapping property test)."""

from __future__ import annotations

import os
from typing import Optional as Opt

# Grüße, naïve café ✓ 😀: non-ASCII text before a declaration
# Logs a user in.
def login(user: str, password: str = "") -> "Session":
    return authenticate(user, password)


# A detached note about the module.

print("loaded", os)
a, b = 1, 2

MAX_RETRIES = 3
TIMEOUT: float = 2.5
handler = lambda req, *args: req

@dataclass
class Session(Base, metaclass=Meta):
    """A session."""

    # How long a session lives.
    ttl: int = 3600
    token = ""

    def __init__(self, store) -> None:
        self.store = store

    @property
    def user(self) -> str:
        return self.token

    @user.setter
    def user(self, value: str) -> None:
        self.token = value

    @staticmethod
    @cache
    async def refresh(force: bool = False, *, retries: int = 3) -> None:
        pass

    class Meta:
        ordering = ["id"]

    # A note at the end of Session.


def over(a): ...
def over(a, b): ...

if __name__ == "__main__":
    login("root")
