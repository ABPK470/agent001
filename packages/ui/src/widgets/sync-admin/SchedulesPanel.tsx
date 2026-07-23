/**
 * SchedulesPanel — cron-driven proposer runs per (source → target) pair.
 */

import { EventType } from "@mia/shared-enums"
import { Plus, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../../client/index"
import { useMe } from "../../hooks/useMe"
import type { SyncEnvironmentAdmin } from "../../types"
import { timeAgo } from "../../lib/util"
import { ConfirmModal } from "./chrome"
import { useConsole } from "./console-context"
import { ScheduleEditorModal } from "./ScheduleEditorModal"
import { PANEL } from "./design"
import { AdminTable, AdminTd, AdminTh, ConsolePanel, Empty, IconAction, PanelBody, PanelToolbar, TOOLBAR_ICON, ToolbarIconBtn } from "./shared"
import { useLiveReload } from "./useLiveReload"

interface Schedule {
  tenant_id:   string
  source:      string
  target:      string
  cron:        string
  enabled:     number
  next_run_at: string | null
  last_run_at: string | null
}

export function SchedulesPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const { notifyError } = useConsole()
  const [items, setItems] = useState<Schedule[]>([])
  const [connections, setConnections] = useState<SyncEnvironmentAdmin[]>([])
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Schedule | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setItems((await api.listProposerSchedules()) as unknown as Schedule[])
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [notifyError])

  useLiveReload(refresh, (type) =>
    type === EventType.SyncProposerScheduleSaved || type === EventType.SyncProposerScheduleDeleted,
  )

  useEffect(() => {
    void api.listSyncEnvironments().then(setConnections).catch(() => setConnections([]))
  }, [])

  async function remove(s: Schedule): Promise<void> {
    try {
      await api.deleteProposerSchedule(s.tenant_id, s.source, s.target)
      await refresh()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <ConsolePanel>
      <PanelToolbar
        busy={busy}
        actions={isAdmin && connections.length > 0 ? (
          <ToolbarIconBtn label="New schedule" onClick={() => setCreating(true)}>
            <Plus {...TOOLBAR_ICON} />
          </ToolbarIconBtn>
        ) : undefined}
      >
        <span className="text-sm font-medium text-text">Proposer schedules</span>
      </PanelToolbar>
      {items.length === 0 ? (
        <Empty title="No schedules" />
      ) : (
        <PanelBody>
          <div className={`${PANEL} overflow-auto`}>
            <AdminTable className="min-w-[700px]">
            <thead>
              <tr>
                <AdminTh>source</AdminTh>
                <AdminTh>target</AdminTh>
                <AdminTh>cron</AdminTh>
                <AdminTh>on</AdminTh>
                <AdminTh>next</AdminTh>
                <AdminTh>last</AdminTh>
                <AdminTh>{""}</AdminTh>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={`${s.tenant_id}|${s.source}|${s.target}`}>
                  <AdminTd className="font-mono">{s.source}</AdminTd>
                  <AdminTd className="font-mono">{s.target}</AdminTd>
                  <AdminTd className="font-mono text-xs">{s.cron}</AdminTd>
                  <AdminTd>{s.enabled ? "✓" : "—"}</AdminTd>
                  <AdminTd className="text-text-muted">{s.next_run_at ? timeAgo(s.next_run_at) : "—"}</AdminTd>
                  <AdminTd className="text-text-muted">{s.last_run_at ? timeAgo(s.last_run_at) : "—"}</AdminTd>
                  <AdminTd>
                    {isAdmin && (
                      <IconAction label="Delete" onClick={() => setDeleting(s)}>
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

      {creating && connections.length > 0 && (
        <ScheduleEditorModal
          connections={connections}
          onClose={() => setCreating(false)}
          onSaved={() => void refresh().catch((err: unknown) => { console.error("[mia]", err) })}
        />
      )}

      {deleting && (
        <ConfirmModal
          title="Delete schedule"
          message={`${deleting.source} → ${deleting.target}?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting).then(() => setDeleting(null)).catch((err: unknown) => { console.error("[mia]", err) })}
        />
      )}
    </ConsolePanel>
  )
}
