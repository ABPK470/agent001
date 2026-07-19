/**
 * Nested H/V split tree — source of truth for workspace tiling.
 * Leaves always cover the full canvas; geometry is projected to LayoutTile rects.
 */

import { COLS, type GridRect, type LayoutTile } from "./grid-math"

export type SplitDir = "h" | "v"

export type SplitNode =
  | { kind: "leaf"; tileId: string }
  | { kind: "split"; dir: SplitDir; ratio: number; a: SplitNode; b: SplitNode }

/** Path from root to a split node (`a` / `b` steps). */
export type SplitPath = readonly ("a" | "b")[]

/** Drop onto an edge of a target leaf (creates a new split). */
export type DropZone = "w" | "e" | "n" | "s"

export interface LeafLayout {
  tileId: string
  rect: GridRect
}

export interface DividerHit {
  path: SplitPath
  dir: SplitDir
  /** Pixel-space divider position along the split axis (grid cells). */
  at: number
}

const DEFAULT_RATIO = 0.5
const MIN_RATIO = 0.08
const MAX_RATIO = 0.92

export function leafNode(tileId: string): SplitNode {
  return { kind: "leaf", tileId }
}

export function collectLeafIds(node: SplitNode | null): string[] {
  if (!node) return []
  if (node.kind === "leaf") return [node.tileId]
  return [...collectLeafIds(node.a), ...collectLeafIds(node.b)]
}

export function containsLeaf(node: SplitNode | null, tileId: string): boolean {
  if (!node) return false
  if (node.kind === "leaf") return node.tileId === tileId
  return containsLeaf(node.a, tileId) || containsLeaf(node.b, tileId)
}

function cloneNode(node: SplitNode): SplitNode {
  if (node.kind === "leaf") return { kind: "leaf", tileId: node.tileId }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: cloneNode(node.a),
    b: cloneNode(node.b),
  }
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

function splitSpan(total: number, ratio: number): { first: number; second: number } {
  const first = Math.max(1, Math.min(total - 1, Math.round(total * clampRatio(ratio))))
  return { first, second: total - first }
}

/** Project the tree into absolute leaf rectangles inside `bounds`. */
export function layoutLeaves(tree: SplitNode | null, bounds: GridRect): LeafLayout[] {
  if (!tree) return []
  const out: LeafLayout[] = []
  layoutLeavesInto(tree, bounds, out)
  return out
}

function layoutLeavesInto(node: SplitNode, bounds: GridRect, out: LeafLayout[]): void {
  if (node.kind === "leaf") {
    out.push({ tileId: node.tileId, rect: { ...bounds } })
    return
  }

  if (node.dir === "v") {
    const { first, second } = splitSpan(bounds.w, node.ratio)
    layoutLeavesInto(node.a, { x: bounds.x, y: bounds.y, w: first, h: bounds.h }, out)
    layoutLeavesInto(node.b, { x: bounds.x + first, y: bounds.y, w: second, h: bounds.h }, out)
    return
  }

  const { first, second } = splitSpan(bounds.h, node.ratio)
  layoutLeavesInto(node.a, { x: bounds.x, y: bounds.y, w: bounds.w, h: first }, out)
  layoutLeavesInto(node.b, { x: bounds.x, y: bounds.y + first, w: bounds.w, h: second }, out)
}

/** Full-canvas bounds for the workspace grid. */
export function canvasBounds(cols = COLS, rows: number): GridRect {
  return { x: 0, y: 0, w: cols, h: Math.max(1, rows) }
}

/**
 * Merge projected leaf geometry onto tile metadata.
 * Unknown leaf ids are skipped; tiles missing from the tree keep metadata but get zero size.
 */
export function projectTiles(
  tree: SplitNode | null,
  tiles: readonly LayoutTile[],
  cols: number,
  rows: number,
): LayoutTile[] {
  const layouts = layoutLeaves(tree, canvasBounds(cols, rows))
  const byId = new Map(layouts.map((leaf) => [leaf.tileId, leaf.rect]))
  return tiles.map((tile) => {
    const rect = byId.get(tile.id)
    if (!rect) return { ...tile, x: 0, y: 0, w: tile.minW, h: tile.minH }
    const { edgePin: _drop, restore: _restore, ...rest } = tile
    return { ...rest, ...rect }
  })
}

/** True when laid-out leaves cover every cell of the canvas with no overlap. */
export function coversCanvas(leaves: readonly LeafLayout[], cols: number, rows: number): boolean {
  if (leaves.length === 0) return true
  const cells = cols * rows
  const seen = new Set<string>()
  let area = 0
  for (const leaf of leaves) {
    const { x, y, w, h } = leaf.rect
    if (x < 0 || y < 0 || x + w > cols || y + h > rows) return false
    area += w * h
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = `${xx},${yy}`
        if (seen.has(key)) return false
        seen.add(key)
      }
    }
  }
  return area === cells && seen.size === cells
}

export function getNodeAt(tree: SplitNode, path: SplitPath): SplitNode | null {
  let node: SplitNode = tree
  for (const step of path) {
    if (node.kind !== "split") return null
    node = step === "a" ? node.a : node.b
  }
  return node
}

export function setSplitRatio(tree: SplitNode, path: SplitPath, ratio: number): SplitNode {
  const next = cloneNode(tree)
  const node = getNodeAt(next, path)
  if (!node || node.kind !== "split") return tree
  node.ratio = clampRatio(ratio)
  return next
}

/**
 * Replace the leaf `targetId` with a split that places `newId` on `zone`.
 * `zone` is the edge of the *target* that the new leaf occupies.
 */
export function splitLeaf(
  tree: SplitNode | null,
  targetId: string,
  newId: string,
  zone: DropZone,
  ratio = DEFAULT_RATIO,
): SplitNode | null {
  if (!tree) return leafNode(newId)
  if (containsLeaf(tree, newId)) return tree
  if (!containsLeaf(tree, targetId)) return tree

  const { dir, newIsA } = zoneToSplit(zone)
  const replacement: SplitNode = newIsA
    ? { kind: "split", dir, ratio: clampRatio(ratio), a: leafNode(newId), b: leafNode(targetId) }
    : { kind: "split", dir, ratio: clampRatio(ratio), a: leafNode(targetId), b: leafNode(newId) }

  return replaceLeaf(tree, targetId, replacement)
}

function zoneToSplit(zone: DropZone): { dir: SplitDir; newIsA: boolean } {
  switch (zone) {
    case "w":
      return { dir: "v", newIsA: true }
    case "e":
      return { dir: "v", newIsA: false }
    case "n":
      return { dir: "h", newIsA: true }
    case "s":
      return { dir: "h", newIsA: false }
  }
}

function replaceLeaf(node: SplitNode, tileId: string, replacement: SplitNode): SplitNode {
  if (node.kind === "leaf") {
    return node.tileId === tileId ? replacement : node
  }
  return {
    ...node,
    a: replaceLeaf(node.a, tileId, replacement),
    b: replaceLeaf(node.b, tileId, replacement),
  }
}

/** Remove a leaf; sibling absorbs its space. Null when the tree becomes empty. */
export function removeLeaf(tree: SplitNode | null, tileId: string): SplitNode | null {
  if (!tree) return null
  if (tree.kind === "leaf") return tree.tileId === tileId ? null : tree
  if (!containsLeaf(tree, tileId)) return tree

  if (tree.a.kind === "leaf" && tree.a.tileId === tileId) return cloneNode(tree.b)
  if (tree.b.kind === "leaf" && tree.b.tileId === tileId) return cloneNode(tree.a)

  if (containsLeaf(tree.a, tileId)) {
    const nextA = removeLeaf(tree.a, tileId)
    if (!nextA) return cloneNode(tree.b)
    return { ...tree, a: nextA }
  }
  const nextB = removeLeaf(tree.b, tileId)
  if (!nextB) return cloneNode(tree.a)
  return { ...tree, b: nextB }
}

/**
 * Move `dragId` onto an edge of `targetId`.
 * Always yields a tree that still covers the same leaf set (minus nothing).
 */
export function reparentLeaf(
  tree: SplitNode | null,
  dragId: string,
  targetId: string,
  zone: DropZone,
): SplitNode | null {
  if (!tree) return null
  if (dragId === targetId) return tree
  if (!containsLeaf(tree, dragId) || !containsLeaf(tree, targetId)) return tree

  const without = removeLeaf(tree, dragId)
  if (!without) return leafNode(dragId)
  return splitLeaf(without, targetId, dragId, zone) ?? without
}

/** Prefer vertical then horizontal 50/50 split of the largest leaf (by area). */
export function splitLargestLeaf(
  tree: SplitNode | null,
  newId: string,
  cols: number,
  rows: number,
): SplitNode {
  if (!tree) return leafNode(newId)
  const leaves = layoutLeaves(tree, canvasBounds(cols, rows))
  if (leaves.length === 0) return leafNode(newId)
  const largest = [...leaves].sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h))[0]!
  const preferV = largest.rect.w >= largest.rect.h
  const zone: DropZone = preferV ? "e" : "s"
  return splitLeaf(tree, largest.tileId, newId, zone) ?? tree
}

/**
 * Find the split whose divider is the given edge of `tileId`.
 * Used when the user grabs a leaf resize handle.
 */
export function findDividerForLeafEdge(
  tree: SplitNode | null,
  tileId: string,
  edge: "n" | "s" | "e" | "w",
  cols: number,
  rows: number,
): DividerHit | null {
  if (!tree) return null
  const bounds = canvasBounds(cols, rows)
  const leaves = layoutLeaves(tree, bounds)
  const leaf = leaves.find((entry) => entry.tileId === tileId)
  if (!leaf) return null
  return findDividerWalk(tree, [], bounds, leaf.rect, edge)
}

function findDividerWalk(
  node: SplitNode,
  path: ("a" | "b")[],
  bounds: GridRect,
  leafRect: GridRect,
  edge: "n" | "s" | "e" | "w",
): DividerHit | null {
  if (node.kind === "leaf") return null

  if (node.dir === "v") {
    const { first, second } = splitSpan(bounds.w, node.ratio)
    const dividerX = bounds.x + first
    const aBounds = { x: bounds.x, y: bounds.y, w: first, h: bounds.h }
    const bBounds = { x: dividerX, y: bounds.y, w: second, h: bounds.h }

    if (edge === "e" && leafRect.x + leafRect.w === dividerX && rectInside(leafRect, aBounds)) {
      return { path, dir: "v", at: dividerX }
    }
    if (edge === "w" && leafRect.x === dividerX && rectInside(leafRect, bBounds)) {
      return { path, dir: "v", at: dividerX }
    }

    return findDividerWalk(node.a, [...path, "a"], aBounds, leafRect, edge)
      ?? findDividerWalk(node.b, [...path, "b"], bBounds, leafRect, edge)
  }

  const { first, second } = splitSpan(bounds.h, node.ratio)
  const dividerY = bounds.y + first
  const aBounds = { x: bounds.x, y: bounds.y, w: bounds.w, h: first }
  const bBounds = { x: bounds.x, y: dividerY, w: bounds.w, h: second }

  if (edge === "s" && leafRect.y + leafRect.h === dividerY && rectInside(leafRect, aBounds)) {
    return { path, dir: "h", at: dividerY }
  }
  if (edge === "n" && leafRect.y === dividerY && rectInside(leafRect, bBounds)) {
    return { path, dir: "h", at: dividerY }
  }

  return findDividerWalk(node.a, [...path, "a"], aBounds, leafRect, edge)
    ?? findDividerWalk(node.b, [...path, "b"], bBounds, leafRect, edge)
}

function rectInside(inner: GridRect, outer: GridRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h
}

/**
 * Convert a pointer delta along a divider into a new ratio for that split.
 * `deltaCells` is signed in the growing direction of side `a` (right for v, down for h).
 */
export function ratioFromDividerDelta(
  tree: SplitNode,
  path: SplitPath,
  deltaCells: number,
  cols: number,
  rows: number,
): number {
  const node = getNodeAt(tree, path)
  if (!node || node.kind !== "split") return DEFAULT_RATIO
  const bounds = boundsForPath(tree, path, canvasBounds(cols, rows))
  if (!bounds) return node.ratio
  const total = node.dir === "v" ? bounds.w : bounds.h
  const { first } = splitSpan(total, node.ratio)
  const nextFirst = Math.max(1, Math.min(total - 1, first + deltaCells))
  return clampRatio(nextFirst / total)
}

/**
 * Continuous divider resize from pixel delta (signed toward growing side `a`).
 * Prefer this for live pointer tracking; cell snap still happens in `layoutLeaves`.
 */
export function ratioFromPixelDelta(
  originRatio: number,
  deltaPx: number,
  axisSpanPx: number,
): number {
  if (axisSpanPx <= 0) return clampRatio(originRatio)
  return clampRatio(originRatio + deltaPx / axisSpanPx)
}

/** Bounds of the node at `path` (the split being resized when path points at it). */
export function splitBoundsAt(
  tree: SplitNode,
  path: SplitPath,
  cols: number,
  rows: number,
): GridRect | null {
  return boundsForPath(tree, path, canvasBounds(cols, rows))
}

function boundsForPath(tree: SplitNode, path: SplitPath, root: GridRect): GridRect | null {
  let node: SplitNode = tree
  let bounds = root
  for (const step of path) {
    if (node.kind !== "split") return null
    if (node.dir === "v") {
      const { first, second } = splitSpan(bounds.w, node.ratio)
      bounds = step === "a"
        ? { x: bounds.x, y: bounds.y, w: first, h: bounds.h }
        : { x: bounds.x + first, y: bounds.y, w: second, h: bounds.h }
    } else {
      const { first, second } = splitSpan(bounds.h, node.ratio)
      bounds = step === "a"
        ? { x: bounds.x, y: bounds.y, w: bounds.w, h: first }
        : { x: bounds.x, y: bounds.y + first, w: bounds.w, h: second }
    }
    node = step === "a" ? node.a : node.b
  }
  return bounds
}

/**
 * Pick a drop zone from pointer position inside a target leaf rect (normalized 0..1).
 * Center band falls through to nearest edge.
 */
export function dropZoneFromPoint(
  localX: number,
  localY: number,
  width: number,
  height: number,
): DropZone {
  if (width <= 0 || height <= 0) return "e"
  const nx = localX / width
  const ny = localY / height
  const distW = nx
  const distE = 1 - nx
  const distN = ny
  const distS = 1 - ny
  const min = Math.min(distW, distE, distN, distS)
  if (min === distW) return "w"
  if (min === distE) return "e"
  if (min === distN) return "n"
  return "s"
}

/** Pixel band rect for a drop zone overlay inside a leaf. */
export function dropZoneRect(leaf: GridRect, zone: DropZone, band = 0.35): GridRect {
  const bw = Math.max(1, Math.round(leaf.w * band))
  const bh = Math.max(1, Math.round(leaf.h * band))
  switch (zone) {
    case "w":
      return { x: leaf.x, y: leaf.y, w: bw, h: leaf.h }
    case "e":
      return { x: leaf.x + leaf.w - bw, y: leaf.y, w: bw, h: leaf.h }
    case "n":
      return { x: leaf.x, y: leaf.y, w: leaf.w, h: bh }
    case "s":
      return { x: leaf.x, y: leaf.y + leaf.h - bh, w: leaf.w, h: bh }
  }
}

/**
 * Build a split tree from legacy absolute rects.
 * Prefers a guillotine partition when possible; otherwise rebuilds by sequential splits
 * so the result always fills the canvas (holes like empty top-right are discarded).
 */
export function treeFromRects(
  tiles: readonly LayoutTile[],
  cols = COLS,
  rows: number,
): SplitNode | null {
  if (tiles.length === 0) return null
  if (tiles.length === 1) return leafNode(tiles[0]!.id)

  const bounds = canvasBounds(cols, rows)
  const asLeaves: LeafLayout[] = tiles.map((tile) => ({
    tileId: tile.id,
    rect: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
  }))

  const guillotine = tryGuillotine(asLeaves, bounds)
  if (guillotine && coversCanvas(layoutLeaves(guillotine, bounds), cols, rows)) {
    return guillotine
  }

  // Holey / non-guillotine layout → rebuild filled tree in stable id order by area.
  const ordered = [...tiles].sort((a, b) => {
    const area = (b.w * b.h) - (a.w * a.h)
    if (area !== 0) return area
    return a.id.localeCompare(b.id)
  })
  let tree: SplitNode = leafNode(ordered[0]!.id)
  for (let i = 1; i < ordered.length; i++) {
    tree = splitLargestLeaf(tree, ordered[i]!.id, cols, rows)
  }
  return tree
}

function tryGuillotine(leaves: LeafLayout[], bounds: GridRect): SplitNode | null {
  const inside = leaves.filter((leaf) => rectsOverlapStrict(leaf.rect, bounds))
  if (inside.length === 0) return null
  if (inside.length === 1) {
    const only = inside[0]!
    if (only.rect.x === bounds.x
      && only.rect.y === bounds.y
      && only.rect.w === bounds.w
      && only.rect.h === bounds.h) {
      return leafNode(only.tileId)
    }
    return null
  }

  // Vertical cut candidates: right edges of leaves that lie strictly inside width.
  const xCuts = new Set<number>()
  for (const leaf of inside) {
    const cut = leaf.rect.x + leaf.rect.w
    if (cut > bounds.x && cut < bounds.x + bounds.w) xCuts.add(cut)
  }
  for (const cut of [...xCuts].sort((a, b) => a - b)) {
    const left = inside.filter((leaf) => leaf.rect.x + leaf.rect.w <= cut)
    const right = inside.filter((leaf) => leaf.rect.x >= cut)
    if (left.length + right.length !== inside.length || left.length === 0 || right.length === 0) {
      continue
    }
    const leftBounds = { x: bounds.x, y: bounds.y, w: cut - bounds.x, h: bounds.h }
    const rightBounds = {
      x: cut,
      y: bounds.y,
      w: bounds.x + bounds.w - cut,
      h: bounds.h,
    }
    const a = tryGuillotine(left, leftBounds)
    const b = tryGuillotine(right, rightBounds)
    if (!a || !b) continue
    return {
      kind: "split",
      dir: "v",
      ratio: clampRatio(leftBounds.w / bounds.w),
      a,
      b,
    }
  }

  const yCuts = new Set<number>()
  for (const leaf of inside) {
    const cut = leaf.rect.y + leaf.rect.h
    if (cut > bounds.y && cut < bounds.y + bounds.h) yCuts.add(cut)
  }
  for (const cut of [...yCuts].sort((a, b) => a - b)) {
    const top = inside.filter((leaf) => leaf.rect.y + leaf.rect.h <= cut)
    const bottom = inside.filter((leaf) => leaf.rect.y >= cut)
    if (top.length + bottom.length !== inside.length || top.length === 0 || bottom.length === 0) {
      continue
    }
    const topBounds = { x: bounds.x, y: bounds.y, w: bounds.w, h: cut - bounds.y }
    const bottomBounds = {
      x: bounds.x,
      y: cut,
      w: bounds.w,
      h: bounds.y + bounds.h - cut,
    }
    const a = tryGuillotine(top, topBounds)
    const b = tryGuillotine(bottom, bottomBounds)
    if (!a || !b) continue
    return {
      kind: "split",
      dir: "h",
      ratio: clampRatio(topBounds.h / bounds.h),
      a,
      b,
    }
  }

  return null
}

function rectsOverlapStrict(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y
}

/** Ensure tree leaf set matches tile ids; rebuild if drift. */
export function ensureTreeForTiles(
  tree: SplitNode | null,
  tiles: readonly LayoutTile[],
  cols: number,
  rows: number,
): SplitNode | null {
  if (tiles.length === 0) return null
  const ids = new Set(tiles.map((tile) => tile.id))
  const leafIds = collectLeafIds(tree)
  const same = leafIds.length === ids.size && leafIds.every((id) => ids.has(id))
  if (same && tree) {
    const leaves = layoutLeaves(tree, canvasBounds(cols, rows))
    if (coversCanvas(leaves, cols, rows)) return tree
  }
  return treeFromRects(tiles, cols, rows)
}
