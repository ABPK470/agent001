/**
 * Generic outline tree shell — renders OutlineNode[] with optional pin overlay.
 * Widgets supply leaf/scope body renderers; catalog owns labels.
 */

import { useMemo, useRef, useState, type ReactNode } from "react"
import type { OutlineNode } from "../../lib/events"
import { OutlineScopeRow } from "./OutlineScope"
import { StickyPinOverlay, type StickyPinRow } from "./StickyPinOverlay"

export type OutlineRenderScope = (node: OutlineNode, opts: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) => ReactNode

export type OutlineRenderLeaf = (node: OutlineNode) => ReactNode

export function OutlineTree({
  nodes,
  openIds,
  onToggle,
  renderScope,
  renderLeaf,
  pinRows,
  className = "",
  emptySlot,
}: {
  nodes: OutlineNode[]
  openIds: Set<string>
  onToggle: (id: string) => void
  renderScope?: OutlineRenderScope
  renderLeaf?: OutlineRenderLeaf
  /** When set, enables VS Code pin overlay over the scroll host. */
  pinRows?: StickyPinRow[]
  className?: string
  emptySlot?: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  function renderNode(node: OutlineNode): ReactNode {
    if (node.kind === "leaf") {
      if (renderLeaf) return <div key={node.id}>{renderLeaf(node)}</div>
      return (
        <OutlineScopeRow
          key={node.id}
          scopeId={node.id}
          family={String(node.family)}
          depth={node.depth}
          open={false}
          onToggle={() => {}}
          leading={node.label}
          title={node.title}
          summary={node.summary}
          expandable={false}
        />
      )
    }

    const open = openIds.has(node.id)
    const childNodes = (node.children ?? []).map(renderNode)
    const body = open ? <div className="outline-tree__children">{childNodes}</div> : null

    if (renderScope) {
      return (
        <div key={node.id} className="outline-tree__scope">
          {renderScope(node, {
            open,
            onToggle: () => onToggle(node.id),
            children: body,
          })}
        </div>
      )
    }

    return (
      <div key={node.id} className="outline-tree__scope">
        <OutlineScopeRow
          scopeId={node.id}
          family={String(node.family)}
          depth={node.depth}
          open={open}
          onToggle={() => onToggle(node.id)}
          leading={node.label}
          title={node.title}
          summary={node.summary}
          expandable={(node.children?.length ?? 0) > 0 || node.atomIds.length > 1}
        />
        {body}
      </div>
    )
  }

  const stickyEligible = useMemo(() => {
    if (!pinRows) return []
    return pinRows
  }, [pinRows])

  return (
    <div className={`outline-tree ${className}`.trim()}>
      <div ref={scrollRef} className="outline-tree__scroll" data-outline-scroll-host>
        {pinRows && pinRows.length > 0 ? (
          <StickyPinOverlay scrollRef={scrollRef} rows={stickyEligible} />
        ) : null}
        {emptySlot}
        <div className="outline-tree__flow">{nodes.map(renderNode)}</div>
      </div>
    </div>
  )
}

/** Local open-set helper for simple outline consumers. */
export function useOutlineOpenState(initial?: Set<string>) {
  const [openIds, setOpenIds] = useState(() => initial ?? new Set<string>())
  function onToggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return { openIds, setOpenIds, onToggle }
}
