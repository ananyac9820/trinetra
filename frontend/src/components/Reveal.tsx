/* Scroll-driven reveals and a pointer-driven tilt.
 *
 * Two small pieces of motion, both from the reference footage, both cheap.
 *
 * `Reveal` holds its children just below their resting position at zero
 * opacity until they enter the viewport, then lets them settle. It uses an
 * IntersectionObserver rather than a scroll listener, so nothing runs on the
 * main thread between reveals, and it disconnects after firing: a section that
 * re-animates every time it scrolls back into view is a section nobody can
 * read.
 *
 * `Tilt` rotates a card a couple of degrees towards the pointer. Two degrees
 * is the whole budget — enough that a surface reads as a physical object under
 * a light, not enough to make a paragraph hard to read while the mouse moves
 * over it. It does nothing on touch, where there is no pointer to follow.
 *
 * Both honour prefers-reduced-motion by rendering the resting state and doing
 * nothing else.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

const reduceMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Reveal({
  children, delay = 0, y = 18, className, style,
}: {
  children: ReactNode; delay?: number; y?: number;
  className?: string; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (reduceMotion()) { setShown(true); return; }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      // A little negative bottom margin, so a block reveals as it comes up
      // into the reading area rather than the instant its top edge appears.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : `translateY(${y}px)`,
        transition:
          `opacity 760ms var(--ease-out) ${delay}ms, ` +
          `transform 760ms var(--ease-out) ${delay}ms`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Tilt({
  children, className, style, max = 2.2,
}: {
  children: ReactNode; className?: string;
  style?: React.CSSProperties; max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion()) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;

    let frame = 0;
    const onMove = (e: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform =
          `perspective(900px) rotateX(${(-py * max).toFixed(2)}deg) ` +
          `rotateY(${(px * max).toFixed(2)}deg) translateZ(0)`;
      });
    };
    const onLeave = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      el.style.transform = "perspective(900px) rotateX(0deg) rotateY(0deg)";
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [max]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        transition: "transform 320ms var(--ease-out), border-color var(--t-fast)",
        transformStyle: "preserve-3d",
        willChange: "transform",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
