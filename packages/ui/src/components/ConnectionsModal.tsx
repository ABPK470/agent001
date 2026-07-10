/**
 * ConnectionsModal — sync environment CRUD from the session menu.
 *
 * Reuses EnvironmentsPanel from sync-admin unchanged; ConsoleProvider supplies toasts.
 */

import { Database, X } from "lucide-react"
import type { JSX } from "react"
import { ConsoleProvider } from "../widgets/sync-admin/console-context"
import { EnvironmentsPanel } from "../widgets/sync-admin/EnvironmentsPanel"
import { WIDGET_ENVELOPE } from "../widgets/sync-admin/design"
import {
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_SURFACE_CLASS,
  modalOverlayClass,
} from "../widgets/entity-registry/modal-overlay"

export function ConnectionsModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className={modalOverlayClass("focus")} onClick={onClose}>
      <div
        className={`${MODAL_SURFACE_CLASS} ${MODAL_ENTITY_FOCUS_PANEL} flex flex-col overflow-hidden`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Database size={20} className="text-text-muted" />
            <div>
              <h2 className="text-lg font-semibold text-text">Connections</h2>
              <p className="text-[13px] text-text-muted">
                Sync environments — source and target rings, access modes, and service URLs.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-overlay-3 hover:text-text"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <ConsoleProvider>
          <div className="sync-admin flex min-h-0 flex-1 flex-col overflow-hidden bg-panel p-3">
            <div className={`${WIDGET_ENVELOPE} min-h-0 flex-1`}>
              <EnvironmentsPanel />
            </div>
          </div>
        </ConsoleProvider>
      </div>
    </div>
  )
}
