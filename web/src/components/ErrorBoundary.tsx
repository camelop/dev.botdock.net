import React, { type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null; errorInfo: React.ErrorInfo | null };

/**
 * Last-resort error boundary around the whole app. Without it, an
 * unhandled render-time throw (e.g. reading a property of an
 * unexpectedly-null session object) leaves the user staring at a blank
 * document body — React unmounts the tree. This component catches those
 * throws, logs them to the console for diagnosis, and shows a visible
 * recovery screen with a Reload button.
 *
 * Error boundaries only catch errors in descendants' render + lifecycle
 * methods. They do NOT catch:
 *   - async errors (setTimeout / Promise rejections)
 *   - event handlers (React lets those bubble to window.onerror)
 *   - errors in the boundary itself
 * For those categories, the boundary is irrelevant — but for the common
 * "I accessed a field on null during render" case it stops a black
 * screen dead in its tracks.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Surface to the console so the actual stack is visible in devtools —
    // the on-screen fallback can't fit a full component stack.
    console.error("[botdock] unhandled render error:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  reset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { error, errorInfo } = this.state;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--bg)",
          color: "var(--fg)",
        }}
      >
        <div
          style={{
            maxWidth: 640,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "20px 24px",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 16, color: "var(--danger)" }}>
            The UI crashed
          </h2>
          <p style={{ fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>
            Something went wrong while rendering. The daemon is probably fine;
            this is a frontend bug. Reload to recover; if it keeps happening,
            the console has the stack trace.
          </p>
          <pre
            className="mono"
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 10,
              fontSize: 11,
              maxHeight: 200,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginTop: 10,
            }}
          >
{error.message || String(error)}
{errorInfo?.componentStack ? "\n\n" + errorInfo.componentStack.trim() : ""}
          </pre>
          <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
            <button className="secondary" onClick={this.reset}>Try again</button>
            <button onClick={() => window.location.reload()}>↻ Reload page</button>
          </div>
        </div>
      </div>
    );
  }
}
