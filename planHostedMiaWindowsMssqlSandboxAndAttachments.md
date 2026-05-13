## Plan: Hosted MIA for Windows, MSSQL, Sandbox, and Attachments

Design a hosted-agent mode that can be deployed on Windows, Linux, or macOS while preserving the same product behavior, safety guarantees, and core performance characteristics across operating systems. The initial deployment is Windows-hosted and used primarily for MSSQL analysis/reporting and metadata synchronization across predefined environments, but the architecture must remain cross-platform by design. The agent must have strong command/file capability inside its own sandbox, no visibility into the app source tree outside that sandbox, and durable attachment handling. Docker must remain a supported sandbox backend, but it cannot be the primary or required mechanism because it will not be available on the initial Windows host. The default hosted design therefore needs a pluggable sandbox abstraction with backend parity across Windows, Linux, macOS, and optional Docker-backed deployments.

**Updated operating assumptions**
- Primary workload: MSSQL interaction, mostly `SELECT`/analysis/reporting plus metadata synchronization between predefined environments.
- Environment safety model: DEV may allow broader operations by configuration; UAT and PROD are read-only by default for hosted use, especially no DML by default.
- Initial host platform: Windows.
- Target deployment platforms: Windows, Linux, and macOS with the same hosted feature set and policy semantics.
- Docker: optional backend only, not available on the initial hosted deployment.
- Hosted mode priority: database-centric agent with sandboxed local processing, not a general-purpose repo-aware coding agent.
- Cross-platform requirement: backend implementations may differ internally by OS, but externally they must honor the same capability contract, attachment flow, policy semantics, audit behavior, and sandbox guarantees.

**Coverage check against prior findings and new note**
- Still in scope and confirmed: prompt currently leaks workspace path/tree; non-admin users retain file write tools; many runs still execute against shared source roots; policy rules are too coarse; admin routes need server-side guards; banning shell alone is insufficient.
- New planning impact from this note: Docker cannot be required for hosted isolation; the sandbox design must be backend-pluggable and Windows-native by default; MSSQL permissions must be first-class in the hosted policy model; tool descriptions and defaults should be optimized for DB/reporting work rather than source-code operations.

**Implementation order**
1. Phase 0 — Contract lock before implementation. Finalize four design contracts first: cross-platform sandbox backend abstraction, hosted sandbox policy model, attachment schema/API contract, and MSSQL environment permission model. This phase is required before code changes because the later phases depend on these interfaces and safety assumptions.
2. Phase 1 — Hosted execution boundary and route hardening. Introduce the hosted/non-admin execution profile, force isolated sandbox roots for hosted runs, stop shared-source execution for analysis/chat, add server-side admin checks on policy/workspace configuration endpoints, and add the new sandbox backend abstraction with Windows-native backend as the first implementation but Linux/macOS parity as a required target.
3. Phase 2 — Hosted tool, policy, and MSSQL enforcement. Replace the current visitor allowlist with a hosted tool profile, add path/command-aware policy evaluation, bind shell/filesystem tools to sandboxRoot, and enforce explicit MSSQL read/write rules per environment with UAT/PROD read-only by default. The policy semantics must be identical across Windows, Linux, and macOS.
4. Phase 3 — Prompt and capability exposure rewrite. Change prompt generation and tool descriptions so the agent sees only OS, shell, architecture, sandbox context, attachment workflow, and MSSQL environment rules, never the real app workspace layout. Prompt semantics and tool capabilities must stay behaviorally aligned across OS-specific sandbox backends.
5. Phase 4 — Attachment ingestion and durable asset store. Replace the current append-to-goal attachment flow with upload, validation, persistence, metadata, and explicit sandbox import semantics.
6. Phase 5 — Output promotion, audit trail, rollout gates, and operational defaults. Align the current workspace diff/promotion UX with the hosted model, add verification coverage, define quotas/retention, and ship behind an explicit hosted profile flag.

**Phase details**
1. Phase 0 — Contract lock.
   Effort: Medium. Risk: Low.
   Deliverables:
   - approved sandbox backend interface,
   - approved hosted policy syntax,
   - approved MSSQL environment permission contract,
   - approved attachment schema/API.
2. Phase 1 — Hosted execution boundary and route hardening.
   Effort: High. Risk: High.
   Work:
   - Add a hosted execution profile in `/Users/abpk470/git/agent001/packages/server/src/orchestrator/run-executor.ts` and `/Users/abpk470/git/agent001/packages/server/src/run-workspace.ts`.
   - Force every hosted run, including analysis/chat, into an isolated sandbox root instead of the shared source root.
   - Introduce a `SandboxBackend` abstraction in the server sandbox layer with at least two implementations: `windows-host` and `docker`.
   - Make `windows-host` the default hosted backend; keep `docker` available as an optional backend for future deployments.
   - Add explicit admin guards to `/Users/abpk470/git/agent001/packages/server/src/routes/policies.ts` and any workspace-setting endpoints wired in `/Users/abpk470/git/agent001/packages/server/src/index.ts`.
   Exit criteria: hosted runs never use shared source roots; non-admin calls to policy/workspace admin APIs fail server-side; backend selection is explicit and pluggable.
3. Phase 1A — Windows-native sandbox backend design and implementation.
   Effort: High. Risk: High.
   Work:
   - Implement a Windows-native process runner that always executes from `sandboxRoot`.
   - Restrict shell/file operations to a server-created sandbox directory tree with canonical path validation.
   - Prefer OS-level process containment primitives where practical for hosted deployments, such as least-privilege service accounts, ACL-restricted sandbox directories, per-run process groups/job control, and disabled inheritance of broader workspace paths.
   - Treat network access as separate capability control, default deny for general shell, with MSSQL access handled through explicit database tools instead of unrestricted shell networking.
   - Preserve the Docker backend contract so the same hosted model can run under Docker elsewhere later.
   Recommendation: do not try to make arbitrary Windows shell commands a full security boundary by themselves. The real boundary should be isolated directories, restricted host account permissions, tool policy, and dedicated DB credentials.
   Exit criteria: the hosted backend on Windows can run local processing commands inside sandboxRoot without any dependency on Docker and without access to the app workspace outside the sandbox.
4. Phase 2 — Hosted tool, policy, and MSSQL enforcement.
   Effort: High. Risk: High.
   Work:
   - Replace the current visitor allowlist in `/Users/abpk470/git/agent001/packages/server/src/tools.ts` with an explicit hosted profile oriented around MSSQL, attachments, and sandbox-local processing.
   - Extend `/Users/abpk470/git/agent001/packages/agent/src/engine/policy.ts` and `/Users/abpk470/git/agent001/packages/agent/src/governance/govern-tool.ts` to evaluate path-aware, command-aware, role-aware, and environment-aware conditions.
   - Make shell and filesystem tools reject any operation whose effective path is outside `sandboxRoot`, including symlink and traversal escapes.
   - Introduce explicit MSSQL environment classes such as `dev`, `uat`, and `prod`, with operation classes such as `read`, `metadata_sync_preview`, and `metadata_sync_execute`.
   - Enforce default permissions so UAT and PROD are read-only unless configuration explicitly overrides that behavior.
   Exit criteria: hosted agents may use shell/file tools only inside sandboxRoot; MSSQL permissions are enforced by environment and operation type, not by prompt wording.
5. Phase 3 — Prompt and capability exposure rewrite.
   Effort: Medium. Risk: Medium-High.
   Work:
   - Split host-visible context from agent-visible context in `/Users/abpk470/git/agent001/packages/server/src/prompt-builder.ts` and `/Users/abpk470/git/agent001/packages/server/src/orchestrator/system-messages.ts`.
   - Hosted prompt includes Windows OS details, shell family, sandbox path, attachment usage guidance, and MSSQL environment rules.
   - Hosted prompt excludes the real workspace root, shallow source tree, source structure, and any non-sandbox path references.
   - Rewrite tool descriptions under `/Users/abpk470/git/agent001/packages/agent/src/tools/`, especially `/Users/abpk470/git/agent001/packages/agent/src/tools/shell.ts`, so the model understands it is operating in a Windows-hosted sandbox with DB-first responsibilities.
   Exit criteria: prompt snapshots for hosted runs show no app source structure and clearly state the MSSQL environment limits.
6. Phase 4 — Attachment ingestion and durable asset store.
   Effort: High. Risk: High.
   Work:
    - Replace the current file-read-and-append logic in `/Users/abpk470/git/agent001/packages/ui/src/widgets/AgentChat.tsx`, `/Users/abpk470/git/agent001/packages/ui/src/widgets/ioe/chat.tsx`, and `/Users/abpk470/git/agent001/packages/ui/src/widgets/OperatorEnvironment.tsx`, and update `/Users/abpk470/git/agent001/packages/ui/src/api.ts` so all existing chat entry points use structured attachment upload instead of embedding file contents into the goal text.
   - Add attachment persistence and query surfaces under `/Users/abpk470/git/agent001/packages/server/src/db/`, `/Users/abpk470/git/agent001/packages/server/src/routes/runs.ts`, and `/Users/abpk470/git/agent001/packages/server/src/orchestrator/orchestrator.ts`.
   - Add agent tools to list attachments, inspect metadata, read approved text content, and import/copy attachments into sandboxRoot for local processing.
    - Keep `TermChat` aligned as a parity surface: it does not currently expose file attachment input, but if attachment support is added there later it must use the same structured attachment pipeline rather than introducing a new inline FileReader-to-goal path.
   - Keep durable stored assets separate from the sandbox so agent writes never mutate the source attachment record.
   Exit criteria: attachments survive restart, carry metadata/tags, and can be explicitly imported into the sandbox.
7. Phase 5 — Output promotion, audit, and rollout.
   Effort: Medium. Risk: Medium.
   Work:
   - Reuse workspace diff/effects machinery so outputs created inside the sandbox can be promoted explicitly into user-visible destinations.
   - Add hosted-mode feature flag/profile and rollout checks.
   - Define operational defaults for retention, quotas, audit logging, and database credential separation by environment.
   Exit criteria: hosted runs have an auditable lifecycle from upload/import to output promotion and database action tracing.

**Cross-platform sandbox backend design**
- Architecture requirement: sandboxing must be backend-pluggable and behaviorally equivalent across Windows, Linux, and macOS.
- Recommended interface:
  - `prepareSandbox(runContext) -> { sandboxRoot, backend, capabilities }`
  - `exec(command, options) -> result`
  - `dispose(runContext)`
- Required backend implementations:
  - `windows-host`: primary initial hosted backend.
  - `linux-host`: first-class host backend with the same contract.
  - `macos-host`: first-class host backend with the same contract.
  - `docker`: optional parity backend for deployments where it is available.
- Backend parity contract:
  - Every backend creates a dedicated sandbox directory outside the app source tree.
  - Every backend starts shell commands in sandboxRoot.
  - Every backend canonicalizes and validates paths before execution and before any filesystem tool call.
  - Every backend enforces the same policy decisions, audit fields, attachment import behavior, and output promotion model.
  - OS-specific implementation details are allowed, but exposed capabilities and restrictions must be functionally equivalent.
- `windows-host` backend rules:
  - The hosted service account should have write access only to sandbox storage and required app-owned state directories, not to the source tree.
  - Prefer ACL-restricted sandbox roots, least-privilege service accounts, and per-run process control.
- `linux-host` and `macos-host` backend rules:
  - Use least-privilege service accounts/users, permission-separated sandbox roots, and process isolation primitives available on the host.
  - Do not rely on Docker availability to achieve parity.
- Security note:
  - On all host-backed deployments, the strongest practical boundary will come from OS account permissions plus isolated sandbox storage, explicit tool restrictions, and DB-side permissioning. The plan should not assume that a plain child-process sandbox alone is sufficient on any OS.

**MSSQL environment permission model**
- Environment records should carry explicit capability policy, not only connection details.
- Recommended fields per environment:
  - `environment_key`: `dev`, `uat`, `prod`.
  - `server_name`, `database_name`, `linked_server_name?`.
  - `role`: `source`, `target`, `reporting`, `mixed`.
  - `default_access_mode`: `read_only` or `read_write`.
  - `allowed_operations`: list such as `query_read`, `sync_preview`, `sync_execute`, `schema_introspect`.
  - `deny_dml`: boolean, default true for UAT/PROD.
  - `deny_ddl`: boolean, default true for hosted mode unless explicitly allowed.
  - `approval_required_operations`: optional list for sensitive actions.
- Hosted default recommendation:
  - DEV: allow `query_read`, `schema_introspect`, `sync_preview`; `sync_execute` configurable.
  - UAT: allow `query_read`, `schema_introspect`, `sync_preview`; deny DML/DDL by default.
  - PROD: allow `query_read`, `schema_introspect`, possibly `sync_preview` if architecturally safe; deny DML/DDL by default.
- Enforcement should occur in MSSQL tool execution and server-side orchestration, not only in prompt text.

**Attachment schema design**
- Core table: `attachments`
- Required fields:
  - `id` — stable UUID.
  - `scope` — `run`, `session`, or `workspace_asset`.
  - `run_id` — nullable for promoted assets.
  - `session_id` — nullable if not session-scoped.
  - `owner_user_id` — uploader/owner.
  - `original_name` — original filename.
  - `normalized_name` — safe display/import name.
  - `media_type` — MIME type.
  - `size_bytes` — file size.
  - `content_hash` — SHA-256 of canonical bytes.
  - `storage_uri` — server-managed storage location.
  - `text_extract_uri` — optional extracted text storage for searchable text-capable files.
  - `ingestion_mode` — `text_inline`, `text_retrieval`, `binary_reference`, or `provider_file_api`.
  - `status` — `uploaded`, `processed`, `rejected`, `deleted`.
  - `source` — `user_upload`, `generated`, or `promoted`.
  - `purpose_tag` — short user/system purpose label.
  - `goal_snapshot` — optional goal text or run reference at time of upload.
  - `uploaded_at`, `processed_at`, `retention_until`.
- Secondary table: `attachment_tags`
  - `attachment_id`, `tag_key`, `tag_value`.
- Secondary table: `attachment_imports`
  - `id`, `attachment_id`, `run_id`, `sandbox_path`, `import_mode`, `imported_at`, `imported_by_tool_call_id`.
- Storage rule:
  - Durable attachment bytes live in a server-owned storage area outside sandbox roots.
  - Imported copies inside sandbox are derived working copies, never the source of truth.

**Attachment API contract**
1. `POST /api/attachments`
   Purpose: upload one or more user files with optional tags and scope.
   Request: multipart form data with file bytes plus JSON fields `scope`, `purposeTag`, `tags`, `runId?`, `sessionId?`.
   Response: attachment metadata objects with IDs and processing status.
2. `GET /api/attachments`
   Purpose: list visible attachments by scope, run, session, or tag.
   Query: `scope`, `runId`, `sessionId`, `tag`, `q`.
3. `GET /api/attachments/:id`
   Purpose: fetch attachment metadata only.
4. `GET /api/attachments/:id/content`
   Purpose: fetch extracted text or downloadable bytes subject to authorization and type restrictions.
5. `POST /api/attachments/:id/import`
   Purpose: copy an attachment into the current run sandbox.
   Request: `{ runId, targetPath?, mode }` where `mode` is `copy` by default.
   Response: imported sandbox path plus import record.
6. `POST /api/runs`
   Updated contract: allow `goal` plus `attachmentIds[]` rather than embedding file content into goal text.
7. Optional provider optimization interface
   Purpose: if a model supports native file inputs, the server may translate an existing attachment into a provider file reference, but the primary run contract still uses internal attachment IDs.

**Attachment handling rules**
- Text attachments should usually be persisted, text-extracted, and exposed by retrieval/tools rather than blindly inlined into the prompt.
- Small text snippets may still be inlined selectively by the server as an optimization, but only from managed attachment records.
- Binary files should be referenced by metadata and imported into sandbox when the agent needs tool-based processing.
- Provider-native file APIs should be optional adapters, not the canonical storage or orchestration model.

**Hosted sandbox policy model**
- Policy evaluation should support conjunctive rule clauses over actor, tool, path, command, network, scope, and database environment.
- Recommended rule shape:
  - `name`
  - `effect`: `allow`, `deny`, `require_approval`
  - `priority`: integer, higher wins before tie-break.
  - `selectors`: object of match conditions.
  - `reason`: human-readable explanation.
- Recommended selectors:
  - `role`: `admin`, `hosted_user`, `visitor`.
  - `tool`: exact tool ID or glob.
  - `path`: sandbox-relative or absolute path pattern after canonicalization.
  - `command`: regex or token matcher against normalized shell command.
  - `network`: `none`, `allow`, or explicit host allowlist.
  - `scope`: `sandbox`, `attachment_store`, `app_workspace`, `system`.
  - `runMode`: `hosted`, `admin`, `development`.
  - `dbEnvironment`: `dev`, `uat`, `prod`.
  - `dbOperation`: `query_read`, `sync_preview`, `sync_execute`, `ddl`, `dml`.
- Exact syntax recommendation:
  - `role:hosted_user & tool:run_command & scope:system -> deny`
  - `role:hosted_user & tool:run_command & path:sandbox://** -> allow`
  - `role:hosted_user & tool:write_file & path:sandbox://** -> allow`
  - `role:hosted_user & tool:read_file & path:workspace://** -> deny`
  - `role:hosted_user & tool:run_command & command:/\b(git|ssh|scp|sudo|winget|powershell\s+Set-|icacls|reg\s+add|net\s+user)\b/i -> deny`
  - `role:hosted_user & tool:mssql_* & dbEnvironment:uat & dbOperation:dml -> deny`
  - `role:hosted_user & tool:mssql_* & dbEnvironment:prod & dbOperation:dml -> deny`
  - `role:hosted_user & tool:mssql_* & dbEnvironment:prod & dbOperation:query_read -> allow`
  - `role:hosted_user & tool:fetch_url & network:none -> deny`
  - `role:admin & tool:* -> allow`
- Resolution rules:
  - Canonicalize tool input first, especially paths, shell commands, and DB operation classification.
  - Evaluate highest priority matching rule first.
  - On equal priority: `deny` beats `require_approval`, which beats `allow`.
  - If no rule matches in hosted mode, default deny.
  - Audit the matched rule name on every decision.

**Hosted-mode defaults**
- Hosted mode is default deny outside sandbox.
- Windows-host backend is the default hosted backend.
- Docker remains optional and supported, but not required.
- Host fallback is disabled for hosted mode.
- Network is denied by default except for explicit DB/tool flows.
- Attachments are readable only through the attachment APIs/tools and become writable only as imported sandbox copies.
- Real app workspace tools are absent or denied for hosted runs.
- UAT and PROD are read-only by default; any override must be explicit configuration and auditable.

**Relevant files**
- `/Users/abpk470/git/agent001/packages/server/src/run-workspace.ts` — isolated vs shared execution-root behavior; must stop shared-root execution for hosted runs.
- `/Users/abpk470/git/agent001/packages/server/src/sandbox/docker-sandbox.ts` — optional Docker backend to preserve.
- `/Users/abpk470/git/agent001/packages/server/src/orchestrator/run-executor.ts` — best insertion point for hosted execution profile and sandbox backend selection.
- `/Users/abpk470/git/agent001/packages/server/src/orchestrator/system-messages.ts` — currently exposes runtime/workspace context; must become sandbox-only for hosted mode.
- `/Users/abpk470/git/agent001/packages/server/src/prompt-builder.ts` — environment/tool/workspace context generation and prompt redaction.
- `/Users/abpk470/git/agent001/packages/server/src/tools.ts` — current visitor/admin tool filtering and hosted profile entry point.
- `/Users/abpk470/git/agent001/packages/agent/src/governance/govern-tool.ts` — enforcement wrapper for richer hosted policies.
- `/Users/abpk470/git/agent001/packages/agent/src/engine/policy.ts` — current tool-name-only policy engine that must grow into a selector-based evaluator.
- `/Users/abpk470/git/agent001/packages/agent/src/tools/filesystem-security.ts` — current boundary checks to strengthen around sandboxRoot.
- `/Users/abpk470/git/agent001/packages/agent/src/tools/shell.ts` — shell description/contract and hosted-mode capability wording.
- `/Users/abpk470/git/agent001/packages/ui/src/widgets/AgentChat.tsx` — current client-side attachment reading and goal concatenation.
- `/Users/abpk470/git/agent001/packages/ui/src/widgets/ioe/chat.tsx` — current IOE chat attachment picker and FileReader-based ingestion.
- `/Users/abpk470/git/agent001/packages/ui/src/widgets/OperatorEnvironment.tsx` — current IOE submit path that appends attachment contents into the goal text before starting a run.
- `/Users/abpk470/git/agent001/packages/ui/src/widgets/TermChat.tsx` — currently no attachment input; should remain aligned with the same attachment contract if/when attachments are introduced there.
- `/Users/abpk470/git/agent001/packages/ui/src/api.ts` — attachment-aware run initiation and upload APIs.
- `/Users/abpk470/git/agent001/packages/server/src/routes/runs.ts` — new run contract using attachment IDs.
- `/Users/abpk470/git/agent001/packages/server/src/orchestrator/orchestrator.ts` — run creation/message seeding from goal plus attachment references.
- `/Users/abpk470/git/agent001/packages/server/src/db/` — attachment metadata persistence and environment permission policy data.
- `/Users/abpk470/git/agent001/packages/server/src/routes/policies.ts` — admin route hardening.

**Verification**
1. Add hosted-mode integration tests proving the prompt contains correct OS details and sandbox path but no real app workspace path/tree on Windows, Linux, and macOS.
2. Add tests proving all hosted runs, including analysis/chat, use isolated sandbox roots and never shared source roots on every supported OS backend.
3. Add shell/file tool tests for traversal, symlink escapes, and blocked OS-specific privileged commands outside hosted policy.
4. Add tests proving hosted mode works without Docker and never requires host Docker availability.
5. Add backend parity tests proving Windows, Linux, and macOS host backends expose the same effective capabilities, policy outcomes, audit fields, and attachment import behavior.
6. Add server-route tests proving non-admin requests to policy/workspace control endpoints are rejected.
7. Add MSSQL policy tests proving UAT/PROD default to read-only and that DML/DDL is blocked unless explicitly configured.
8. Add attachment upload/persistence/import tests, including restart durability and metadata/tag integrity.
9. Add tests proving `POST /api/runs` uses attachment IDs rather than concatenated attachment content.
10. Run server, agent, and UI build/test scopes after each phase, then one end-to-end hosted scenario per OS class: upload attachment -> start run with attachment ID -> import into sandbox -> local processing -> MSSQL read/report workflow -> promote output.

**Decisions**
- Included: hosted Windows-first sandbox mode, optional Docker backend retention, MSSQL-first hosted permissions, route hardening, selector-based hosted policy model, structured attachment ingestion, and prompt/tool capability rewrite.
- Excluded: unrelated chat UX and delegation rendering changes from earlier notes.
- Recommended default: provider-native file inputs remain optional provider adapters, not the canonical system behavior.
- Recommended default: preserve the richer admin/developer mode separately rather than weakening all modes to hosted constraints.

**Further Considerations**
1. The strongest boundary on Windows will likely come from service-account permissions plus ACL-separated sandbox storage, not from shell restrictions alone. That should be treated as a deployment requirement, not just an app feature.
2. If sync execution against DEV is allowed, define whether it is direct execution or still approval-gated; the answer affects both MSSQL policy and UI language.
3. If later you need controlled outbound access for downloads or package tools, introduce a separate hosted profile like `hosted_fetch` instead of weakening the strict default.
