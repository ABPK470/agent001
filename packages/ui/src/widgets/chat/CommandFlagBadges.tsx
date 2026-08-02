export function CommandFlagBadges({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null
  return (
    <span className="composer-cmd-flags" aria-label={`Options: ${flags.join(", ")}`}>
      {flags.map((flag) => (
        <span key={flag} className="composer-cmd-flag">
          {flag}
        </span>
      ))}
    </span>
  )
}
