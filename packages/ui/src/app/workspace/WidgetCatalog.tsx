/**
 * WidgetCatalog — modal for adding product surfaces to the active layout.
 */

import { LayoutDashboard } from "lucide-react"
import { useIsMobile } from "../../hooks/useIsMobile"
import { useMe } from "../../hooks/useMe"
import { useLayoutStore } from "../../state/layout-store"
import type { WidgetType } from "../../types"
import { VISITOR_WIDGETS } from "../../types"
import { ModalShell } from "../../widgets/entity-registry/ModalShell"
import { modalViewerPanelClass } from "../../widgets/entity-registry/modal-overlay"
import { catalogEntries } from "./widget-definitions"

interface Props {
  onClose: () => void
}

export function WidgetCatalog({ onClose }: Props) {
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const views = useLayoutStore((s) => s.views)
  const addWidget = useLayoutStore((s) => s.addWidget)
  const removeWidget = useLayoutStore((s) => s.removeWidget)
  const isMobile = useIsMobile()
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const activeView = views.find((view) => view.id === activeViewId)
  const activeTypes = new Set(activeView?.tiles.map((tile) => tile.type) ?? [])

  function handleToggle(type: WidgetType) {
    const existing = activeView?.tiles.find((tile) => tile.type === type)
    if (existing) {
      removeWidget(activeViewId, existing.id)
    } else {
      addWidget(activeViewId, type)
    }
  }

  return (
    <ModalShell
      title="Add to layout"
      subtitle="Pick surfaces for this layout."
      icon={<LayoutDashboard size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={modalViewerPanelClass(isMobile)}
    >
      <div
        className={`min-h-0 flex-1 overflow-y-auto p-5 show-scrollbar grid gap-2.5 ${
          isMobile ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-3"
        }`}
      >
        {catalogEntries().map((item) => {
          const isActive = activeTypes.has(item.type)
          const isAllowed = isAdmin || VISITOR_WIDGETS.has(item.type)
          const Icon = item.icon
          return (
            <button
              key={item.type}
              disabled={!isAllowed}
              title={isAllowed ? undefined : "Available to admins only"}
              className={`relative flex items-center gap-3.5 rounded-xl text-left p-4 transition-colors border ${
                !isAllowed
                  ? "border-border text-text-faint opacity-45 cursor-not-allowed"
                  : isActive
                    ? "border-border-strong bg-panel cursor-pointer shadow-[inset_0_0_0_1px_var(--text)]"
                    : "border-border bg-panel text-text-muted hover:border-border-strong hover:text-text cursor-pointer"
              }`}
              onClick={() => { if (isAllowed) handleToggle(item.type) }}
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border ${
                isActive && isAllowed
                  ? "border-border-strong text-text"
                  : "border-border text-text-muted"
              }`}>
                <Icon size={18} className="block shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium block ${
                  isActive && isAllowed ? "text-text" : "text-text-secondary"
                }`}>
                  {item.label}
                </span>
                <span className={`text-[13px] leading-snug block mt-0.5 ${
                  isActive && isAllowed ? "text-text-secondary" : "text-text-muted"
                }`}>
                  {item.desc}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </ModalShell>
  )
}
