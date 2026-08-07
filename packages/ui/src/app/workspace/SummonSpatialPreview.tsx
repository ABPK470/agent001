/**
 * Summon right pane — flush structural column (not a floating card).
 * Rail header aligns with the left filter bar; canvas fills the rest.
 */

import { spaceById } from "../../lib/spaces"
import type { SummonPreviewModel } from "./summon-preview"
import { summonPreviewHotkeyHint } from "./summon-preview"
import { SpaceLayoutPreview } from "./SpaceLayoutPreview"
import { getWidgetDefinition } from "./widget-definitions"

export function SummonSpatialPreview({
  model,
  highlightPickIndex = null,
  onSelectTile,
}: {
  model: SummonPreviewModel
  highlightPickIndex?: number | null
  onSelectTile?: (tileId: string) => void
}) {
  if (model.mode === "idle") {
    return (
      <div className="summon-spatial" aria-live="polite">
        <div className="summon-spatial__rail">
          <span className="summon-spatial__rail-title">Preview</span>
        </div>
        <div className="summon-spatial__pane summon-spatial__pane--idle">
          <p className="summon-spatial__idle-prompt">{model.prompt}</p>
        </div>
      </div>
    )
  }

  if (model.mode === "surface") {
    return <SurfaceColumn model={model} />
  }

  const tileCount = model.pickable.length
  const hotkeyHint = summonPreviewHotkeyHint(tileCount)
  const badge =
    tileCount <= 0 ? null : tileCount === 1 ? "1 tile" : `${hotkeyHint} tiles`

  return (
    <div className="summon-spatial summon-spatial--blueprint" aria-live="polite">
      <div className="summon-spatial__rail">
        <span className="summon-spatial__rail-title">{model.name} · Space</span>
        {badge ? <span className="summon-spatial__rail-badge">{badge}</span> : null}
      </div>
      <div className="summon-spatial__pane">
        {model.meta ? (
          <p className="summon-spatial__meta">{model.meta}</p>
        ) : null}
        <div className="summon-spatial__canvas">
          <SpaceLayoutPreview
            variant="embedded"
            name={model.name}
            split={model.split}
            tiles={model.tiles}
            highlightPickIndex={highlightPickIndex}
            onSelectTile={onSelectTile}
          />
        </div>
      </div>
    </div>
  )
}

function SurfaceColumn({
  model,
}: {
  model: Extract<SummonPreviewModel, { mode: "surface" }>
}) {
  const def = getWidgetDefinition(model.type)
  const Icon = def.icon
  const dedicated = model.dedicatedSpace
    ? spaceById(model.dedicatedSpace)?.name
    : null
  const staging = model.pickedCount > 0
  const action = staging
    ? model.onActiveSpace
      ? "Click / Space stages remove · Enter applies"
      : "Click / Space stages keep · Enter applies"
    : model.onActiveSpace
      ? "Enter focuses · Click / Space stages remove"
      : "Click stages · Enter keeps · right-click peeks"
  const badge = staging
    ? model.onActiveSpace
      ? "drop"
      : "add"
    : model.onActiveSpace
      ? "here"
      : "keep"

  return (
    <div className="summon-spatial summon-spatial--surface" aria-live="polite">
      <div className="summon-spatial__rail">
        <span className="summon-spatial__rail-title">Surface</span>
        <span className="summon-spatial__rail-badge">{badge}</span>
      </div>
      <div className="summon-spatial__pane summon-spatial__pane--surface">
        <div className="summon-spatial__surface-body">
          <div className="summon-spatial__surface-icon" aria-hidden>
            <Icon size={22} />
          </div>
          <h3 className="summon-spatial__surface-title">{model.name}</h3>
          <p className="summon-spatial__surface-desc">{model.desc}</p>
        </div>
        <div className="summon-spatial__surface-footer">
          <p className="summon-spatial__surface-action">{action}</p>
          <p className="summon-spatial__surface-hint">
            {staging
              ? "Absent → keep · Active → remove · Esc clears bag"
              : dedicated
                ? `Also lands as ${dedicated} Space via Go`
                : "\u00a0"}
          </p>
        </div>
      </div>
    </div>
  )
}
