/**
 * MakeAdClips brand mark — a play/clip triangle anchored by two diagonal
 * crop-marks (the frame motif), in signal orange. This is the canonical
 * in-app logo mark; it mirrors app/icon.svg (favicon) so the tab icon and the
 * header logo are the same identity.
 *
 * Uses `currentColor` for the mark so it inherits the accent via `text-accent`,
 * and the rounded ink tile adapts to theme by default (transparent) — pass
 * `tile` to render the standalone rounded-square badge version.
 */
export default function BrandMark({ className = "", tile = false, title = "MakeAdClips" }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {tile && <rect width="32" height="32" rx="7" className="fill-ink" />}
      <g
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="square"
      >
        <path d="M6.5 10V6.5H10" />
        <path d="M25.5 22v3.5H22" />
      </g>
      <path d="M12.5 10 L23 16 L12.5 22 Z" fill="currentColor" />
    </svg>
  );
}
