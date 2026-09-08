/* The ambient background.
 *
 * Two crossed volumetric beams rising from below the fold, a soft overhead
 * glow, and a faint measured grid. It is decorative, but it is the thing that
 * stops a near-black page from reading as an empty page, and it is drawn in
 * CSS gradients rather than as an image so it costs nothing to load and scales
 * to any viewport.
 *
 * It is deliberately not a cyclone illustration. The map is the product's
 * imagery; inventing a second, fake satellite picture for decoration would sit
 * badly next to a product whose whole argument is about labelling what is real.
 */

interface Props {
  /** Beams from the bottom (landing hero) or a single overhead wash (pages). */
  variant?: "hero" | "page";
}

export default function Ambient({ variant = "page" }: Props) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute", inset: 0, overflow: "hidden",
        pointerEvents: "none", zIndex: 0,
      }}
    >
      {/* Overhead wash. Present in both variants; it lifts the top of the
          page just enough for the floating nav to have something to sit on. */}
      <div
        style={{
          position: "absolute", left: "50%", top: variant === "hero" ? -280 : -340,
          width: 1400, height: 700, transform: "translateX(-50%)",
          background:
            "radial-gradient(closest-side, rgba(79,224,207,0.16), transparent 72%)",
          filter: "blur(18px)",
        }}
      />

      {variant === "hero" && (
        <>
          {/* The two crossed beams. Each is drawn twice: a wide, heavily
              blurred halo and a narrow bright core on top of it. One element
              alone gives either a soft smudge or a hard wedge; the pair is
              what reads as a volumetric shaft of light. */}
          {[-1, 1].map((dir) => (
            <div key={dir}>
              <div
                className="breathe"
                style={{
                  position: "absolute",
                  left: "50%", bottom: "4%",
                  width: 260, height: "150%",
                  transformOrigin: "50% 100%",
                  mixBlendMode: "screen",
                  transform: `translateX(-50%) rotate(${dir * 52}deg)`,
                  background:
                    "linear-gradient(to top, rgba(56,189,248,0.40), " +
                    "rgba(79,224,207,0.20) 40%, transparent 88%)",
                  filter: "blur(40px)",
                  animationDelay: dir > 0 ? "0s" : "-5.5s",
                }}
              />
              <div
                className="breathe"
                style={{
                  position: "absolute",
                  left: "50%", bottom: "4%",
                  width: 52, height: "142%",
                  transformOrigin: "50% 100%",
                  mixBlendMode: "screen",
                  transform: `translateX(-50%) rotate(${dir * 52}deg)`,
                  background:
                    "linear-gradient(to top, rgba(186,252,244,0.62), " +
                    "rgba(120,236,232,0.30) 26%, transparent 84%)",
                  filter: "blur(9px)",
                  animationDelay: dir > 0 ? "-2s" : "-7.5s",
                }}
              />
            </div>
          ))}

          {/* The convergence point itself, brighter and tighter. */}
          <div
            style={{
              position: "absolute", left: "50%", bottom: "-6%",
              width: 720, height: 300, transform: "translateX(-50%)",
              mixBlendMode: "screen",
              background:
                "radial-gradient(closest-side, rgba(150,236,236,0.34), transparent 74%)",
              filter: "blur(38px)",
            }}
          />

          {/* A scrim behind the copy. The beams pass through the headline's
              band, and without this the type has to compete with them. */}
          <div
            style={{
              position: "absolute", left: "50%", top: "34%",
              width: "min(1080px, 92%)", height: 420,
              transform: "translate(-50%, -50%)",
              background:
                "radial-gradient(ellipse at center, rgba(4,6,10,0.62) 34%, transparent 72%)",
            }}
          />

          {/* A horizon line so the beams appear to stand on something. */}
          <div
            style={{
              position: "absolute", left: 0, right: 0, bottom: "5%", height: 1,
              background:
                "linear-gradient(90deg, transparent, rgba(146,178,208,0.22) 30%, " +
                "rgba(146,178,208,0.22) 70%, transparent)",
            }}
          />
        </>
      )}

      {/* The measured grid, masked so it fades out well before the edges. */}
      <div
        className="grid-bg"
        style={{
          position: "absolute", inset: 0, opacity: 0.85,
          maskImage:
            "radial-gradient(ellipse 70% 60% at 50% 32%, #000 10%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 60% at 50% 32%, #000 10%, transparent 78%)",
        }}
      />
    </div>
  );
}
