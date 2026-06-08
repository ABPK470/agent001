# auth

Authentication and session-related adapter implementations.

Keep transport-edge auth handlers in `api/`. Keep durable auth/session stores
under `adapters/persistence/` when they are truly durable.
