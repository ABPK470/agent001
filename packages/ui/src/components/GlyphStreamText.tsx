/**
 * Live streaming prose — append-only, no glyph scramble.
 *
 * The old settle path swapped each new character through monospace ASCII
 * noise on a 40ms tick. That changed glyph widths every frame and made
 * markdown reflow (and stick-to-bottom) look shaky. Characters now appear
 * as themselves; a quiet trailing cue marks the live edge.
 */

export function GlyphStreamText({
  text,
  className = "",
}: {
  text: string
  className?: string
}) {
  if (!text) return null

  return (
    <span className={["glyph-stream-text", className].filter(Boolean).join(" ")}>
      {text}
      <span className="glyph-stream-cue" aria-hidden="true" />
    </span>
  )
}
