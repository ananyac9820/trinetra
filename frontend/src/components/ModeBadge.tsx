/* The LIVE / REPLAY badge.
 *
 * The specification is blunt about this one: it must not be hidden, ever,
 * including in fullscreen. So it lives in the application shell rather than in
 * any page, and there is no prop that turns it off.
 *
 * In replay it also shows the storm name and the simulated timestamp, because a
 * replay badge without a timestamp invites the viewer to read the display as
 * current.
 */

import { useEffect, useState } from "react";
import { api, formatUtcShort } from "../api/client";
import type { ModeInfo } from "../api/types";
import { useStore } from "../state/store";

export default function ModeBadge() {
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const { mode, at } = useStore();

  useEffect(() => {
    let alive = true;
    api.mode().then((m) => { if (alive) setInfo(m); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const live = mode === "live";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {info && !info.model_loaded && (
        <span
          className="tele"
          style={{ color: "var(--warn)" }}
          title={info.warnings.join(" ")}
        >
          no model checkpoint
        </span>
      )}
      <span className={`mode-badge ${live ? "live" : "replay"}`}>
        {live ? <span className="pulse" /> : <span style={{ fontSize: 9 }}>■</span>}
        {live ? "LIVE" : "REPLAY"}
        {!live && at && (
          <span className="num" style={{ opacity: 0.85, letterSpacing: 0 }}>
            {formatUtcShort(at)}
          </span>
        )}
      </span>
    </div>
  );
}
