/* Shared chrome for the document pages.
 *
 * Archive, Methods, Upload, Report and Storm detail are five different
 * arguments, and before this they were five different layouts. One page shell,
 * one heading rhythm and one section rule is what makes them read as one
 * product rather than five templates that happen to share a colour scheme.
 *
 * Nothing here is page-specific. A page supplies an eyebrow, a title, a lede
 * and its actions; everything else is fixed.
 */

import type { ReactNode } from "react";
import Ambient from "./Ambient";

interface PageProps {
  eyebrow?: ReactNode;
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** Rendered under the lede, above the first section. */
  meta?: ReactNode;
  children: ReactNode;
  width?: number;
}

export default function Page({
  eyebrow, title, lede, actions, meta, children, width = 1160,
}: PageProps) {
  return (
    <div style={{ position: "absolute", inset: 0, overflowY: "auto" }}>
      <div style={{ position: "relative", minHeight: "100%" }}>
        <div style={{ position: "absolute", inset: "0 0 auto 0", height: 460 }}>
          <Ambient variant="page" />
        </div>

        <div
          style={{
            position: "relative", zIndex: 1, maxWidth: width, margin: "0 auto",
            padding: "34px 30px 56px",
          }}
        >
          <header className="rise" style={{ marginBottom: 26 }}>
            {eyebrow && (
              <div style={{ marginBottom: 14 }}>
                <span className="eyebrow">{eyebrow}</span>
              </div>
            )}
            <div
              style={{
                display: "flex", alignItems: "flex-end", gap: 20,
                flexWrap: "wrap",
              }}
            >
              <h1 className="display-sm" style={{ flex: "1 1 auto" }}>{title}</h1>
              {actions && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {actions}
                </div>
              )}
            </div>
            {lede && (
              <p
                style={{
                  fontSize: 14, color: "var(--fg-1)", lineHeight: 1.7,
                  maxWidth: 780, margin: "14px 0 0",
                }}
              >
                {lede}
              </p>
            )}
            {meta && <div style={{ marginTop: 12 }}>{meta}</div>}
            <div className="hair sweep" style={{ marginTop: 22 }} />
          </header>

          {children}
        </div>
      </div>
    </div>
  );
}

/* A section rule with a title and an optional right-aligned note. The note is
   where a page puts the caveat that belongs next to the heading rather than
   buried at the end of the section. */
export function Section({
  title, note, id,
}: { title: string; note?: ReactNode; id?: string }) {
  return (
    <div
      id={id}
      style={{
        display: "flex", alignItems: "baseline", gap: 12,
        margin: "34px 0 12px", scrollMarginTop: 80,
      }}
    >
      <h2 style={{ fontSize: 15, letterSpacing: "-0.01em" }}>{title}</h2>
      <span className="hair" style={{ flex: 1 }} />
      {note && <span className="tele">{note}</span>}
    </div>
  );
}

/* A framed block. Used for every body panel on a document page so the corner
   registration ticks and the border weight are decided once. */
export function Card({
  children, pad = "16px 18px", style, className = "",
}: {
  children: ReactNode; pad?: string;
  style?: React.CSSProperties; className?: string;
}) {
  return (
    <div
      className={`panel ticked ${className}`}
      style={{ padding: pad, ...style }}
    >
      {children}
    </div>
  );
}

/* A single labelled readout. The label is telemetry, the value is tabular, and
   the note underneath is where the uncertainty or the provenance goes. Every
   large number in the product is one of these. */
export function Stat({
  label, value, unit, sub, colour, size = 22,
}: {
  label: string; value: string; unit?: string; sub?: ReactNode;
  colour?: string; size?: number;
}) {
  return (
    <div>
      <div className="tele">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6,
                    marginTop: 4 }}>
        <span
          className="num count-in"
          style={{ fontSize: size, color: colour ?? "var(--fg)",
                   letterSpacing: "-0.02em" }}
        >
          {value}
        </span>
        {unit && <span className="tele">{unit}</span>}
      </div>
      {sub && (
        <div className="tele" style={{ marginTop: 3, whiteSpace: "normal",
                                       lineHeight: 1.5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
