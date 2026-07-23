/** Default models per provider shown in the UI picker. */
export const DEFAULT_PROVIDER = "databricks"

/** Default model when no override is set (Copilot Chat). */
export const DEFAULT_COPILOT_MODEL = "gpt-5.4"

/** Default Databricks serving endpoint name. */
export const DEFAULT_DATABRICKS_MODEL = "databricks-gpt-5-4"

export const PROVIDER_DEFAULTS: Record<string, { model: string; baseUrl: string; placeholder: string }> = {
  "copilot-chat": {
    model: DEFAULT_COPILOT_MODEL,
    baseUrl: "",
    placeholder: "Automatic (Device Flow — authorize once)"
  },
  databricks: {
    model: DEFAULT_DATABRICKS_MODEL,
    baseUrl: "",
    placeholder: "Automatic (M2M OAuth from .env)"
  }
}
