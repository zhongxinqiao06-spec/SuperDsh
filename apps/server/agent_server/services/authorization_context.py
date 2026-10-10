"""Request-scoped references bind derived links to the issuing login session."""

from contextvars import ContextVar

authorization_reference: ContextVar[dict | None] = ContextVar(
    "authorization_reference", default=None
)


def current_authorization_reference() -> dict:
    return dict(authorization_reference.get() or {})
