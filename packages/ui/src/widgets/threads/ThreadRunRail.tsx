import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type RefObject,
} from "react"
import { TruncationHint, isTextTruncated } from "../../components/TruncationHint"
import {
  activeBarIndexForRun,
  chatChromeDockTop,
  collectRunNavMarkers,
  hasRoomForRunMinimap,
  layoutRunNavBars,
  pickNavRunInView,
  runLabel,
  shouldShowRunMinimap,
  type RunNavMarker,
} from "./runNavLayout"

export interface ThreadRunNavItem {
  id: string
  goal: string
  createdAt: string
}

interface Props {
  runs: ThreadRunNavItem[]
  onSelectRun: (runId: string) => void
  scrollHostRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  /** Parent calls this on every transcript scroll so the rail stays in sync. */
  scrollSyncRef?: RefObject<(() => void) | null>
}

interface RailLayout {
  visible: boolean
  dockTop: number
  bars: ReturnType<typeof layoutRunNavBars>
}

const EMPTY: RailLayout = {
  visible: false,
  dockTop: 0,
  bars: { bars: [], hasMore: false, trackHeight: 0 },
}

export function ThreadRunRail({
  runs,
  onSelectRun,
  scrollHostRef,
  contentRef,
  scrollSyncRef,
}: Props) {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<RailLayout>(EMPTY)
  const [navRunId, setNavRunId] = useState<string | null>(null)
  const [hint, setHint] = useState<{ text: string; anchor: DOMRect } | null>(null)

  const markersRef = useRef<RunNavMarker[]>([])
  const transcriptRunIdsRef = useRef<string[]>([])
  const pinnedRunIdRef = useRef<string | null>(null)

  const transcriptRuns = runs
  const transcriptRunIds = useMemo(() => transcriptRuns.map((run) => run.id), [transcriptRuns])
  transcriptRunIdsRef.current = transcriptRunIds

  const syncFromScroll = useCallback(() => {
    const host = scrollHostRef.current
    const content = contentRef.current
    const runIds = transcriptRunIdsRef.current
    if (!host || !content || runIds.length === 0) return

    const scrolled = pickNavRunInView(host, content, runIds)
    if (!scrolled) return

    if (pinnedRunIdRef.current) {
      setNavRunId(pinnedRunIdRef.current)
      if (scrolled === pinnedRunIdRef.current) {
        pinnedRunIdRef.current = null
      }
      return
    }

    setNavRunId(scrolled)
  }, [scrollHostRef, contentRef])

  const selectRun = useCallback((runId: string) => {
    pinnedRunIdRef.current = runId
    setNavRunId(runId)
    setHint(null)
    onSelectRun(runId)
  }, [onSelectRun])

  function onCapsuleItemEnter(
    event: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>,
    goal: string,
  ) {
    const el = event.currentTarget
    const shown = runLabel(goal)
    // Hint when CSS ellipsis kicks in, or when the label was string-clipped.
    if (!isTextTruncated(el) && shown === goal) return
    setHint({ text: goal, anchor: el.getBoundingClientRect() })
  }

  function onCapsuleItemLeave() {
    setHint(null)
  }

  function onRailLeave() {
    setOpen(false)
    setHint(null)
  }

  const recomputeLayout = useCallback(() => {
    const host = scrollHostRef.current
    const content = contentRef.current
    if (!host || !content || !hasRoomForRunMinimap(window.innerWidth)) {
      markersRef.current = []
      setLayout(EMPTY)
      return
    }

    const contentHeight = content.scrollHeight
    const clientHeight = host.clientHeight
    const dockTop = chatChromeDockTop(host)
    const markerInputs = collectRunNavMarkers(content, host, transcriptRunIds)

    if (!shouldShowRunMinimap(markerInputs.length, clientHeight, contentHeight)) {
      markersRef.current = []
      setLayout(EMPTY)
      return
    }

    markersRef.current = markerInputs
    setLayout({
      visible: true,
      dockTop,
      bars: layoutRunNavBars(markerInputs),
    })
    syncFromScroll()
  }, [transcriptRunIds, scrollHostRef, contentRef, syncFromScroll])

  useLayoutEffect(() => {
    if (!scrollSyncRef) return
    scrollSyncRef.current = syncFromScroll
    return () => {
      scrollSyncRef.current = null
    }
  }, [scrollSyncRef, syncFromScroll])

  useEffect(() => {
    recomputeLayout()

    const host = scrollHostRef.current
    const content = contentRef.current
    if (!host || !content) return

    let scrollRaf = 0
    const onScroll = () => {
      cancelAnimationFrame(scrollRaf)
      scrollRaf = requestAnimationFrame(syncFromScroll)
    }

    const ro = new ResizeObserver(() => recomputeLayout())
    ro.observe(host)
    ro.observe(content)
    host.addEventListener("scroll", onScroll, { passive: true })
    host.addEventListener("scrollend", syncFromScroll, { passive: true })
    window.addEventListener("resize", recomputeLayout, { passive: true })
    return () => {
      cancelAnimationFrame(scrollRaf)
      ro.disconnect()
      host.removeEventListener("scroll", onScroll)
      host.removeEventListener("scrollend", syncFromScroll)
      window.removeEventListener("resize", recomputeLayout)
    }
  }, [recomputeLayout, syncFromScroll, scrollHostRef, contentRef])

  useEffect(() => {
    recomputeLayout()
  }, [transcriptRuns, recomputeLayout])

  if (!layout.visible) return null

  const highlightRunId = navRunId ?? transcriptRunIds[transcriptRunIds.length - 1] ?? null
  if (!highlightRunId) return null

  const activeBarIndex = activeBarIndexForRun(
    layout.bars.bars,
    transcriptRunIds,
    highlightRunId,
  )

  const style = {
    "--thread-run-track-h": `${layout.bars.trackHeight}px`,
    top: `${Math.round(layout.dockTop)}px`,
  } as CSSProperties

  return (
    <nav
      className="thread-run-rail"
      style={style}
      aria-label="Runs in this thread"
    >
      <div
        className={`thread-run-rail-hit${open ? " thread-run-rail-hit--open" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={onRailLeave}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) onRailLeave()
        }}
      >
        <div className="thread-run-rail-bars" aria-hidden={open}>
          <div className="thread-run-rail-chrome">
            <div className="thread-run-rail-track">
              {layout.bars.bars.map((bar, index) => (
                <button
                  key={`${bar.id}-${index}`}
                  type="button"
                  className={`thread-run-rail-bar${
                    index === activeBarIndex ? " thread-run-rail-bar--active" : ""
                  }`}
                  style={{ top: `${Math.round(bar.top)}px` }}
                  aria-label={runLabel(transcriptRuns.find((r) => r.id === bar.id)?.goal ?? "")}
                  aria-current={index === activeBarIndex ? "true" : undefined}
                  onClick={() => selectRun(bar.id)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="thread-run-rail-capsule" role="navigation" aria-label="Jump to run">
          <div className={`thread-run-rail-capsule-scroll${transcriptRuns.length > 12 ? " thread-run-rail-capsule-scroll--overflow" : ""}`}>
            {transcriptRuns.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`thread-run-rail-capsule-item${
                  run.id === highlightRunId ? " thread-run-rail-capsule-item--active" : ""
                }`}
                aria-current={run.id === highlightRunId ? "true" : undefined}
                onClick={() => selectRun(run.id)}
                onMouseEnter={(e) => onCapsuleItemEnter(e, run.goal)}
                onMouseLeave={onCapsuleItemLeave}
                onFocus={(e) => onCapsuleItemEnter(e, run.goal)}
                onBlur={onCapsuleItemLeave}
              >
                {runLabel(run.goal)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {hint && <TruncationHint text={hint.text} anchor={hint.anchor} side="left" />}
    </nav>
  )
}
