import { StrictMode, type ComponentType } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { IntroBreath } from "./components/IntroBreath"
import { IntroConversationRoute } from "./components/IntroConversation"
import { IntroCursor } from "./components/IntroCursor"
import "./index.css"

function normalizePath(path: string): string {
  const normalized = path.replace(/\/+$/, "")
  return normalized || "/"
}

const basePath = normalizePath(import.meta.env.BASE_URL)
const join = (suffix: string) =>
  normalizePath(`${basePath === "/" ? "" : basePath}/${suffix}`)

const routes: Record<string, ComponentType> = {
  [join("intro")]:  IntroCursor,
  [join("intro2")]: IntroBreath,
  [join("intro3")]: IntroConversationRoute,
}

const currentPath = normalizePath(window.location.pathname)
const RootComponent: ComponentType = routes[currentPath] ?? App

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <RootComponent />
    </ErrorBoundary>
  </StrictMode>,
)
