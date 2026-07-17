import { useEffect, useRef, useState } from "react"

interface Props {
  title: string
  shellActive: boolean
  revealText: string | null
  onRevealComplete: (finalTitle: string) => void
}

type Mode = "shell" | "typing" | "label"

export function ThreadTitleMaterialize({
  title,
  shellActive,
  revealText,
  onRevealComplete,
}: Props) {
  const [mode, setMode] = useState<Mode>(() => (shellActive && !revealText ? "shell" : "label"))
  const [typed, setTyped] = useState("")
  const completedRef = useRef(false)

  useEffect(() => {
    completedRef.current = false
  }, [revealText, shellActive])

  useEffect(() => {
    if (revealText) return
    if (shellActive) {
      setMode("shell")
      setTyped("")
      return
    }
    setMode("label")
  }, [shellActive, revealText])

  useEffect(() => {
    if (!revealText) return

    setMode("typing")
    setTyped("")
    let index = 0
    let cancelled = false

    const step = () => {
      if (cancelled) return
      index += 1
      setTyped(revealText.slice(0, index))
      if (index >= revealText.length) {
        window.setTimeout(() => {
          if (cancelled || completedRef.current) return
          completedRef.current = true
          setMode("label")
          onRevealComplete(revealText)
        }, 90)
        return
      }
      window.setTimeout(step, 26)
    }

    const start = window.setTimeout(step, 100)
    return () => {
      cancelled = true
      window.clearTimeout(start)
    }
  }, [revealText, onRevealComplete])

  if (mode === "shell") {
    return <span className="thread-rail-title-shell" aria-hidden="true" />
  }

  if (mode === "typing") {
    return (
      <span className="thread-rail-item-title thread-rail-item-title--typing block min-w-0 truncate">
        {typed}
        <span className="thread-rail-title-caret" aria-hidden="true" />
      </span>
    )
  }

  return (
    <span className="thread-rail-item-title block min-w-0 truncate">
      {title}
    </span>
  )
}
