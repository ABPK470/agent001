/**
 * Server-only enums for the `sandbox` domain.
 */

/** Sandbox backend implementation — host process or docker container. */
export const SandboxBackendKind = {
  Host: "host",
  Docker: "docker"
} as const

export type SandboxBackendKind = (typeof SandboxBackendKind)[keyof typeof SandboxBackendKind]

export const SANDBOX_BACKEND_KINDS: ReadonlyArray<SandboxBackendKind> = Object.values(SandboxBackendKind)

export const isSandboxBackendKind = (value: unknown): value is SandboxBackendKind =>
  typeof value === "string" && (SANDBOX_BACKEND_KINDS as readonly string[]).includes(value)

/**
 * Workspace mount-access mode for the docker sandbox.
 *
 * Controls how the host workspace is bind-mounted into the container.
 *   - None      — no workspace mount (fully isolated)
 *   - Readonly  — host → /workspace:ro (analysis only)
 *   - Readwrite — host → /workspace:rw (default — the agent edits files)
 */
export const WorkspaceMountMode = {
  None: "none",
  Readonly: "readonly",
  Readwrite: "readwrite"
} as const

export type WorkspaceMountMode = (typeof WorkspaceMountMode)[keyof typeof WorkspaceMountMode]

export const WORKSPACE_MOUNT_MODES: ReadonlyArray<WorkspaceMountMode> = Object.values(WorkspaceMountMode)

export const isWorkspaceMountMode = (value: unknown): value is WorkspaceMountMode =>
  typeof value === "string" && (WORKSPACE_MOUNT_MODES as readonly string[]).includes(value)
