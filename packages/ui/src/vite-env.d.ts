/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOME_SHELL?: "legacy" | "thread"
  /** Local laptop harness only — never set on hosted. */
  readonly VITE_LOCAL_RUN_SIMULATE?: string
}
