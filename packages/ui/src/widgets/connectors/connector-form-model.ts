/**
 * Connector form snapshot — the editable shape used by the Connectors modal
 * form. Mirrors `sync-environments/environment-form-model.ts`: a UI-friendly snapshot
 * plus pure helpers to load from / save to the admin wire type.
 */

import {
  withConnectorConfigDefaults,
  type ConnectorAdmin,
  type ConnectorKindId,
} from "@mia/shared-types"

export type ConfigValue = string | number | boolean | null
export type ConnectorFormSnapshot = {
  id: string
  kind: ConnectorKindId
  name: string
  displayName: string
  enabled: boolean
  config: Record<string, ConfigValue>
}

export function emptyConnectorFormSnapshot(kind: ConnectorKindId): ConnectorFormSnapshot {
  return {
    id: "",
    kind,
    name: "",
    displayName: "",
    enabled: true,
    config: withConnectorConfigDefaults(kind, {}),
  }
}

export function cloneConnectorFormSnapshot(snapshot: ConnectorFormSnapshot): ConnectorFormSnapshot {
  return {
    ...snapshot,
    config: { ...snapshot.config },
  }
}

export function connectorFormFromAdmin(admin: ConnectorAdmin): ConnectorFormSnapshot {
  return {
    id: admin.id,
    kind: admin.kind,
    name: admin.name,
    displayName: admin.displayName,
    enabled: admin.enabled,
    config: { ...admin.config },
  }
}

export function connectorFormToPayload(
  snapshot: ConnectorFormSnapshot,
): Record<string, unknown> {
  return {
    id: snapshot.id.trim(),
    kind: snapshot.kind,
    name: snapshot.name.trim(),
    displayName: snapshot.displayName.trim(),
    enabled: snapshot.enabled,
    config: { ...snapshot.config },
  }
}
