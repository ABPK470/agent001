/**
 * Toolbar — top bar with branding, governance settings, usage, and connection status.
 */

import { Activity, LayoutGrid, Shield } from "lucide-react"
import { useState } from "react"
import { useStore } from "../store"
import { Logo } from "./Logo"
import { PolicyEditor } from "./PolicyEditor"
import { UsageModal } from "./UsageModal"

interface Props {
  onAddWidget?: () => void
}

export function Toolbar({ onAddWidget }: Props) {
  const connected = useStore((s) => s.connected)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  return (
    <>
      <header className="flex items-center justify-between px-6 h-14 bg-base shrink-0 select-none">
        <div className="flex items-center">
          <Logo size={30} online={connected} />
        </div>

        <div className="flex items-center gap-2.5">
          {onAddWidget && (
            <button
              className="flex items-center gap-2 px-3.5 py-2 text-sm text-text-secondary hover:text-white border border-white/10 hover:border-white/25 rounded-lg transition-colors"
              onClick={onAddWidget}
              title="Add Widget"
            >
              <LayoutGrid size={15} />
              <span className="hidden sm:inline">Add Widget</span>
            </button>
          )}

          <button
            className="flex items-center gap-2 px-3.5 py-2 text-sm text-text-secondary hover:text-white border border-white/10 hover:border-white/25 rounded-lg transition-colors"
            onClick={() => setUsageOpen(true)}
            title="Token Usage"
          >
            <Activity size={15} />
            <span className="hidden sm:inline">Usage</span>
          </button>

          <button
            className="flex items-center gap-2 px-3.5 py-2 text-sm text-text-secondary hover:text-white border border-white/10 hover:border-white/25 rounded-lg transition-colors"
            onClick={() => setPolicyOpen(true)}
            title="Governance Policies"
          >
            <Shield size={15} />
            <span className="hidden sm:inline">Policies</span>
          </button>
        </div>
      </header>

      {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
    </>
  )
}
