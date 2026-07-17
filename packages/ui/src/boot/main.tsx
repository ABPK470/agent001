import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "../app/App"
import { ErrorBoundary } from "../components/ErrorBoundary"
import { TransitionTestPage } from "../app/TransitionTestPage"
import "./index.css"

const isTransitionTestRoute = window.location.pathname.endsWith("/test1")

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isTransitionTestRoute ? <TransitionTestPage /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
)
