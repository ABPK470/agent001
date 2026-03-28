/**
 * Toolbar — top bar with branding, governance settings, usage, and connection status.
 */

import { Activity, Radio, Shield, Wifi, WifiOff } from "lucide-react"
import { useState } from "react"
import { useStore } from "../store"
import { PolicyEditor } from "./PolicyEditor"
import { UsageModal } from "./UsageModal"

export function Toolbar() {
  const connected = useStore((s) => s.connected)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  return (
    <>
      <header className="flex items-center justify-between px-5 h-11 bg-surface shrink-0 select-none">
        <div className="flex items-center gap-3">
          <Radio size={18} className="text-accent" />
          <span className="text-base font-semibold tracking-wide text-text">
            AGENT<span className="text-accent">001</span>
          </span>
          {/* <span className="text-[13px] text-text-muted font-mono">COMMAND CENTER</span> */}
        </div>

        <div className="flex items-center gap-4">
          <button
            className="flex items-center gap-1.5 text-[13px] text-text-muted hover:text-text-secondary"
            onClick={() => setUsageOpen(true)}
            title="Token Usage"
          >
            <Activity size={15} />
            <span className="hidden sm:inline">Usage</span>
          </button>

          <button
            className="flex items-center gap-1.5 text-[13px] text-text-muted hover:text-text-secondary"
            onClick={() => setPolicyOpen(true)}
            title="Governance Policies"
          >
            <Shield size={15} />
            <span className="hidden sm:inline">Policies</span>
          </button>

          <div className="flex items-center gap-2">
            {connected ? (
              <Wifi size={16} className="text-success" />
            ) : (
              <WifiOff size={16} className="text-error" />
            )}
            <span className="text-[13px] text-text-secondary">
              {connected ? "Live" : "Offline"}
            </span>
          </div>
        </div>
      </header>

      {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
    </>
  )
}
