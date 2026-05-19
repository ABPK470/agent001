/**
 * Shared bits for the three /intro* concept routes.
 *
 *   /intro   — IntroCursor       (cursor IS the agent)
 *   /intro2  — IntroBreath       (one breath: dot ↔ line)
 *   /intro3  — IntroConversation (chat from turn zero)
 *
 * Each concept lives in its own component file. They share:
 *   - loginOrRegister()  → identical auth contract as the original /intro
 *   - introBasePath()    → respects Vite's BASE_URL
 *   - <IntroSwitcher/>   → tiny faint footer to hop between the three
 */

export async function loginOrRegister(username: string, password: string): Promise<void> {
  const post = (url: string, body: Record<string, unknown>) =>
    fetch(url, {
      method:      "POST",
      credentials: "include",
      headers:     { "content-type": "application/json" },
      body:        JSON.stringify(body),
    })

  const login = await post("/api/auth/login", { username, password })
  if (login.ok) return
  if (login.status === 401) {
    const reg = await post("/api/auth/register", {
      username, password, displayName: username,
    })
    if (reg.ok) return
    if (reg.status === 409) throw new Error("wrong password")
    const body = await reg.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `sign-up failed (${reg.status})`)
  }
  const body = await login.json().catch(() => ({})) as { error?: string }
  throw new Error(body.error ?? `sign-in failed (${login.status})`)
}

export function introBasePath(): string {
  const normalized = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")
  return normalized || "/"
}

function introHref(suffix: string): string {
  const base = introBasePath()
  return base === "/" ? `/${suffix}` : `${base}/${suffix}`
}

export function IntroSwitcher({ current }: { current: 1 | 2 | 3 }) {
  const items: Array<{ n: 1 | 2 | 3; label: string; href: string }> = [
    { n: 1, label: "cursor",       href: introHref("intro")  },
    { n: 2, label: "breath",       href: introHref("intro2") },
    { n: 3, label: "conversation", href: introHref("intro3") },
  ]
  return (
    <nav className="intro-switcher" aria-label="intro concepts">
      {items.map((it) => (
        <a
          key={it.n}
          href={it.href}
          aria-current={current === it.n ? "page" : undefined}
          className={`intro-switcher__link${current === it.n ? " intro-switcher__link--active" : ""}`}
        >
          <span className="intro-switcher__n">{it.n}</span>
          <span className="intro-switcher__label">{it.label}</span>
        </a>
      ))}
    </nav>
  )
}
