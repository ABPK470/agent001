/**
 * RoutesPanel — notification routes per event type and channel.
 */

import { EventType } from "@mia/shared-enums"
import { Hash, Mail, MessageSquare, Plus, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useState } from "react"
import { api } from "../../client/index"
import { useMe } from "../../hooks/useMe"
import { timeAgo } from "../../lib/util"
import { ConfirmModal } from "./chrome"
import { useConsole } from "./console-context"
import { RouteEditorModal } from "./RouteEditorModal"
import { PANEL } from "./design"
import { AdminTable, AdminTd, AdminTh, ConsolePanel, Empty, IconAction, PanelBody, PanelToolbar, TOOLBAR_ICON, ToolbarIconBtn } from "./shared"
import { useLiveReload } from "./useLiveReload"

type Channel = "email" | "teams" | "slack"

interface Route {
  id:          string
  tenant_id:   string
  event_type:  string
  filter_json: string
  channel:     Channel
  target:      string
  enabled:     boolean
  updated_at:  string
  updated_by:  string
}

function normalizeRoute(row: Record<string, unknown>): Route {
  const filter = row["filter"]
  const filterJson = typeof row["filter_json"] === "string"
    ? row["filter_json"]
    : JSON.stringify(filter && typeof filter === "object" ? filter : {})
  return {
    id: String(row["id"] ?? ""),
    tenant_id: String(row["tenant_id"] ?? row["tenantId"] ?? ""),
    event_type: String(row["event_type"] ?? row["eventType"] ?? ""),
    filter_json: filterJson,
    channel: String(row["channel"] ?? "email") as Channel,
    target: String(row["target"] ?? ""),
    enabled: row["enabled"] === true || row["enabled"] === 1,
    updated_at: String(row["updated_at"] ?? row["updatedAt"] ?? ""),
    updated_by: String(row["updated_by"] ?? row["updatedBy"] ?? ""),
  }
}

export function RoutesPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { notifyError } = useConsole()
  const [items, setItems] = useState<Route[]>([])
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Route | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const rows = await api.listNotificationRoutes()
      setItems((rows as Array<Record<string, unknown>>).map(normalizeRoute))
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [notifyError])

  useLiveReload(refresh, (type) =>
    type === EventType.SyncNotificationRouteSaved || type === EventType.SyncNotificationRouteDeleted,
  )

  async function remove(r: Route): Promise<void> {
    try {
      await api.deleteNotificationRoute(r.id)
      await refresh()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <ConsolePanel>
      <PanelToolbar
        busy={busy}
        actions={isAdmin ? (
          <ToolbarIconBtn label="New route" onClick={() => setCreating(true)}>
            <Plus {...TOOLBAR_ICON} />
          </ToolbarIconBtn>
        ) : undefined}
      >
        <span className="text-sm font-medium text-text">Notification routes</span>
      </PanelToolbar>
      {items.length === 0 ? (
        <Empty title="No routes" />
      ) : (
        <PanelBody>
          <div className={`${PANEL} overflow-auto`}>
          <AdminTable>
            <thead>
              <tr>
                <AdminTh>event</AdminTh>
                <AdminTh>channel</AdminTh>
                <AdminTh>target</AdminTh>
                <AdminTh>filter</AdminTh>
                <AdminTh>on</AdminTh>
                <AdminTh>updated</AdminTh>
                <AdminTh>{""}</AdminTh>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <AdminTd className="font-mono">{r.event_type}</AdminTd>
                  <AdminTd><ChannelBadge channel={r.channel} /></AdminTd>
                  <AdminTd className="max-w-[200px] truncate" title={r.target}>{r.target}</AdminTd>
                  <AdminTd className="max-w-[160px] truncate font-mono text-xs" title={r.filter_json}>{r.filter_json}</AdminTd>
                  <AdminTd>{r.enabled ? "✓" : "—"}</AdminTd>
                  <AdminTd className="text-text-muted">{timeAgo(r.updated_at)}</AdminTd>
                  <AdminTd>
                    {isAdmin && (
                      <IconAction label="Delete" onClick={() => setDeleting(r)}>
                        <Trash2 {...TOOLBAR_ICON} />
                      </IconAction>
                    )}
                  </AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          </div>
        </PanelBody>
      )}

      {creating && (
        <RouteEditorModal
          onClose={() => setCreating(false)}
          onSaved={() => void refresh()}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete route"
          message={`${deleting.event_type} → ${deleting.channel}?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting).then(() => setDeleting(null))}
        />
      )}
    </ConsolePanel>
  )
}

function ChannelBadge({ channel }: { channel: Channel }): JSX.Element {
  const Icon = channel === "email" ? Mail : channel === "teams" ? MessageSquare : Hash
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border-subtle bg-overlay-2 px-1.5 py-0.5 text-xs">
      <Icon className="h-3.5 w-3.5" /> {channel}
    </span>
  )
}
