/* A route-level error boundary.
 *
 * The Explorer's map is a WebGL surface driven by two libraries and a live
 * store, and a throw anywhere inside it unmounts the entire application, which
 * during a demo means a black screen with no explanation. A boundary turns that
 * into a panel that says what failed and offers a reload.
 *
 * It reports the message rather than swallowing it, because a boundary that
 * hides the error is worse than the crash: the crash at least tells you
 * something is wrong.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Named in the message, so a viewer knows which surface failed. */
  label?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on the console rather than sent anywhere: this build has no
    // telemetry endpoint and inventing one would be a privacy decision made
    // in a UI component.
    console.error("TRINETRA render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: "absolute", inset: 0, display: "grid", placeItems: "center",
          padding: 24,
        }}
      >
        <div
          className="panel ticked"
          style={{
            maxWidth: 520, padding: "20px 22px",
            borderColor: "color-mix(in srgb, var(--alert) 40%, transparent)",
          }}
        >
          <div className="tele" style={{ color: "var(--alert)", marginBottom: 8 }}>
            {this.props.label ?? "This view"} failed to render
          </div>
          <div style={{ fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.65 }}>
            {error.message || String(error)}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button onClick={() => window.location.reload()}>Reload the page</button>
          </div>
          <div className="disclaimer" style={{ marginTop: 16 }}>
            Nothing was estimated or displayed from partial data. The rest of
            the application is still reachable from the navigation above.
          </div>
        </div>
      </div>
    );
  }
}
