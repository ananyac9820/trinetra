/* The application shell.
 *
 * TRINETRA is a multi-page platform rather than a dashboard, and the split is
 * not cosmetic. The Explorer is a heavy WebGL surface with its own state
 * machine, its own tile service and its own time model. Putting it on the
 * landing page makes both worse: the landing page needs to load fast and orient
 * a stranger, and the Explorer needs to be a workspace.
 *
 * The mode badge is in the shell rather than in the Explorer, because it must
 * be visible in every viewport at every size, including fullscreen, and it must
 * never be hidden.
 */

import { Suspense, lazy, useEffect } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
                  minHeight: 0 }}>
      <header
        style={{
          display: "flex", alignItems: "center", gap: 16,
          padding: "0 14px", height: 42, flex: "none",
          borderBottom: "1px solid var(--line)",
          background: "var(--bg-1)", position: "relative", zIndex: 20,
        }}
      >
        <Link
          to="/"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            textDecoration: "none", color: "var(--fg)",
          }}
        >
          <svg width="17" height="17" viewBox="0 0 32 32" aria-hidden>
            <circle cx="16" cy="16" r="13.5" fill="none" stroke="var(--accent)"
                    strokeWidth="1.4" />
            <ellipse cx="16" cy="16" rx="13.5" ry="5" fill="none"
                     stroke="var(--accent-dim)" strokeWidth="1" />
            <circle cx="16" cy="16" r="3.4" fill="var(--accent)" />
          </svg>
          <span
            style={{ fontFamily: "var(--mono)", fontSize: 13.5,
                     letterSpacing: "0.22em", fontWeight: 500 }}
          >
            TRINETRA
          </span>
        </Link>

        <nav style={{ display: "flex", gap: 2 }}>
          {NAV.map((n) => {
            const on = location.pathname.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                style={{
                  padding: "4px 9px", borderRadius: "var(--r-sm)",
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

        <span className="tele" style={{ display: isExplorer ? "none" : "inline" }}>
          North Indian Ocean
        </span>
        <ModeBadge />
      </header>

      <main style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <Suspense
          fallback={
            <div style={{ padding: 24 }}>
              <span className="tele">loading…</span>
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
      </main>
    </div>
  );
}
