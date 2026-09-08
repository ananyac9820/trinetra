/* Viewport breakpoints for the Explorer.
 *
 * The Explorer's panels float over the map rather than sitting in a grid, so
 * they cost no width — but the timeline and the legend reserve space between
 * them, and below about 1180 px that leaves the map a sliver and squeezes the
 * time readout onto four lines.
 *
 * Two breakpoints, both about what fits rather than about device classes:
 *
 *   compact   the timeline runs the full width beneath the panels instead of
 *             between them, the legend starts folded, and the viewport preset
 *             buttons are dropped, since they are a convenience and the map
 *             still pans.
 *   tight     the panels start closed. Their toggles stay on screen, so this
 *             is a starting position rather than a restriction.
 */

import { useEffect, useState } from "react";

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function useViewport() {
  const compact = useMediaQuery("(max-width: 1180px)");
  const tight = useMediaQuery("(max-width: 880px)");
  return { compact, tight };
}
