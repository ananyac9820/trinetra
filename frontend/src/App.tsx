/* The application shell.
 *
 * TRINETRA is a multi-page platform rather than a dashboard, and the split is
 * not cosmetic. The Explorer is a heavy WebGL surface with its own state
 * machine, its own tile service and its own time model. Putting it on the
 * landing page makes both worse: the landing page needs to load fast and orient
 * a stranger, and the Explorer needs to be a workspace.
 *
 * The shell has two forms. On document pages it is a bar with a rule under it.
 * On the Explorer it floats: the map runs edge to edge underneath and the
 * chrome is a translucent pill over it, because on a map-first surface a solid
 * header is a strip of viewport that shows no data.
 *
 * The mode badge is in the shell rather than in the Explorer, because it must
 * be visible in every viewport at every size, including fullscreen, and it must
 * never be hidden.
 */

import { Suspense, lazy, useEffect } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

import ErrorBoundary from "./components/ErrorBoundary";
import ModeBadge from "./components/ModeBadge";
import { api } from "./api/client";
import { useStore } from "./state/store";

const Landing = lazy(() => import("./routes/Landing"));
const Explorer = lazy(() => import("./routes/Explorer"));
const StormDetail = lazy(() => import("./routes/StormDetail"));
const Report = lazy(() => import("./routes/Report"));
const Methods = lazy(() => import("./routes/Methods"));
const Archive = lazy(() => import("./routes/Archive"));
const Upload = lazy(() => import("./routes/Upload"));

const NAV = [
  { to: "/explorer", label: "Explorer" },
  { to: "/archive", label: "Archive" },
  { to: "/upload", label: "Upload" },
  { to: "/methods", label: "Methods" },
];

export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="13.5" fill="none" stroke="var(--accent)"
              strokeWidth="1.4" opacity="0.9" />
      <ellipse cx="16" cy="16" rx="13.5" ry="5" fill="none"
               stroke="var(--accent-dim)" strokeWidth="1" />
      <ellipse cx="16" cy="16" rx="5" ry="13.5" fill="none"
               stroke="var(--accent-dim)" strokeWidth="1" opacity="0.5" />
      <circle cx="16" cy="16" r="3.2" fill="var(--accent)" />
    </svg>
  );
}

export default function App() {
  const setManifest = useStore((s) => s.setManifest);
  const set = useStore((s) => s.set);
  const location = useLocation();

  /* The manifest is fetched once and drives every provenance visual in the
     app, so it is loaded in the shell rather than per route. */
  useEffect(() => {
    let alive = true;
    api.layers().then((m) => { if (alive) setManifest(m); }).catch(() => {});
    api.mode().then((m) => { if (alive) set({ mode: m.mode }); }).catch(() => {});
    return () => { alive = false; };
  }, [setManifest, set]);

  const isExplorer = location.pathname.startsWith("/explorer");
  const isLanding = location.pathname === "/";
  const floating = isExplorer || isLanding;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  minHeight: 0, position: "relative" }}>
      <header
        style={{
          display: "flex", alignItems: "center", gap: 18,
          padding: floating ? "0 18px" : "0 20px",
          height: "var(--chrome-h)",
          flex: "none",
          borderBottom: floating ? "1px solid transparent" : "1px solid var(--line)",
          background: floating ? "transparent" : "rgba(7,10,16,0.86)",
          backdropFilter: floating ? "none" : "var(--glass-blur)",
          position: floating ? "absolute" : "relative",
          top: 0, left: 0, right: 0,
          zIndex: 40,
          pointerEvents: "none",
        }}
      >
        {/* On a floating shell every cluster carries its own glass, so the
            chrome stays readable over whatever scrolls beneath it rather than
            needing an opaque bar across the whole viewport. */}
        <Link
          to="/"
          className={floating ? "glass" : undefined}
          style={{
            display: "flex", alignItems: "center", gap: 9,
            textDecoration: "none", color: "var(--fg)", pointerEvents: "auto",
            padding: floating ? "7px 15px" : 0,
            borderRadius: "var(--r-pill)",
          }}
        >
          <Mark size={19} />
          <span
            style={{ fontFamily: "var(--mono)", fontSize: 13.5,
                     letterSpacing: "0.26em", fontWeight: 500 }}
          >
            TRINETRA
          </span>
        </Link>

        <nav
          className={floating ? "glass" : undefined}
          style={{
            display: "flex", gap: 2, pointerEvents: "auto",
            padding: floating ? 3 : 0,
            borderRadius: "var(--r-pill)",
            ...(floating ? {} : { border: 0, background: "transparent",
                                  boxShadow: "none" }),
          }}
        >
          {NAV.map((n) => {
            const on = location.pathname.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                style={{
                  padding: floating ? "5px 14px" : "5px 11px",
                  borderRadius: "var(--r-pill)",
                  fontSize: 12, textDecoration: "none",
                  color: on ? "var(--accent)" : "var(--fg-2)",
                  background: on ? "var(--accent-glow)" : "transparent",
                  transition: "color var(--t-fast), background var(--t-fast)",
                }}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <span style={{ flex: 1 }} />

        <div
          className={floating ? "glass" : undefined}
          style={{
            display: "flex", alignItems: "center", gap: 12,
            pointerEvents: "auto",
            padding: floating ? "5px 10px 5px 14px" : 0,
            borderRadius: "var(--r-pill)",
          }}
        >
          <span className="tele" style={{ display: isExplorer ? "none" : "inline" }}>
            North Indian Ocean
          </span>
          <ModeBadge />
        </div>
      </header>

      <main
        style={{
          flex: 1, minHeight: 0, position: "relative",
          ...(floating ? { position: "absolute", inset: 0 } : {}),
        }}
      >
        <ErrorBoundary key={location.pathname} label="This page">
        <Suspense
          fallback={
            <div style={{ position: "absolute", inset: 0, display: "grid",
                          placeItems: "center" }}>
              <span className="tele fade">initialising…</span>
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/explorer" element={<Explorer />} />
            <Route path="/storm/:id" element={<StormDetail />} />
            <Route path="/storm/:id/report" element={<Report />} />
            <Route path="/archive" element={<Archive />} />
            <Route path="/upload" element={<Upload />} />
            <Route path="/methods" element={<Methods />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
