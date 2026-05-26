# api

Transport edge for `@mia/server`.

This folder is the target home for:

- HTTP routes
- SSE/event transport
- channels/webhooks
- request/response shaping

Anything here should be transport-facing, not domain or durable-storage logic.