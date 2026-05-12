import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", color: "var(--color-error)", background: "var(--color-canvas)", minHeight: "100vh" }}>
          <h2 style={{ marginBottom: 8 }}>UI Crashed</h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--color-warning)" }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--color-text-muted)", fontSize: 12, marginTop: 12 }}>{this.state.error.stack}</pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            style={{ marginTop: 16, padding: "8px 16px", background: "var(--color-accent)", color: "var(--color-text-on-accent)", border: "none", borderRadius: 6, cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
