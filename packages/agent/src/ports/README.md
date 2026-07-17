# Ports

**What:** Contracts for outside dependencies, plus port-backed services.  
**Why:** Keep I/O at the edge; core stays pure.  
**Next:** Server implements host ports; runs use `createEngineServices()` for in-memory adapters.

| Path | Contents |
| ---- | -------- |
| `ports.ts` | Host/store/client/sink shapes |
| `services/` | `AuditService`, `Learner`, Memory* adapters |
