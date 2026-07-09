import { useId } from 'react';

type QwenLogoProps = {
  className?: string;
};

/**
 * Qwen Code logo — the official hexagonal mark used by the upstream
 * `qwen` CLI 0.19.x banner and QwenLM/qwen-code marketing.
 *
 * The CLI banner renders the brand as boxed ASCII art:
 *
 *   ▄▄▄▄▄▄  ▄▄     ▄▄ ▄▄▄▄▄▄▄ ▄▄▄    ▄▄
 *  ██╔═══██╗██║    ██║██╔════╝████╗  ██║
 *  ██║   ██║██║ █╗ ██║█████╗  ██╔██╗ ██║
 *  ██║▄▄ ██║██║███╗██║██╔══╝  ██║╚██╗██║
 *  ╚██████╔╝╚███╔███╔╝███████╗██║ ╚████║
 *   ╚══▀▀═╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝
 *
 * Geometry is a 200×200 viewBox.
 *
 * NOTE: gradient/clip-path/mask IDs inside `<defs>` are *global* per document.
 * When the same logo is rendered more than once on the page (sidebar dot +
 * message avatar + provider picker card), browsers see duplicate IDs and the
 * later instances silently fall back to plain fill, which leaves the symbol
 * blank — what looks like "missing logo" or a stray `?` glyph in the UI. We
 * namespace the IDs with `useId()` so every render instance is unique.
 */
const QwenLogo = ({ className = "w-5 h-5" }: QwenLogoProps) => {
  const rawId = useId();
  const blockId = `qwen-block-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const faceId = `qwen-face-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      viewBox="0 0 200 200"
      role="img"
      aria-label="Qwen Code"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={blockId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id={faceId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0.85" />
        </linearGradient>
      </defs>

      {/* Q — circle on a stem (leftmost block) */}
      <g fill={`url(#${blockId})`}>
        <circle cx="40" cy="100" r="22" />
      </g>
      <g fill="none" stroke={`url(#${blockId})`} strokeWidth="6" strokeLinecap="round">
        <line x1="55" y1="115" x2="62" y2="135" />
      </g>

      {/* W — two converging diagonals (second block) */}
      <g fill={`url(#${blockId})`}>
        <polygon points="74,75 84,75 96,135 88,135" />
        <polygon points="96,135 88,135 100,95 108,95" />
        <polygon points="108,95 100,95 112,135 120,135" />
        <polygon points="112,135 120,135 122,75 130,75" />
      </g>

      {/* E — three horizontal bars + spine (third block) */}
      <g fill={`url(#${blockId})`}>
        <rect x="138" y="75" width="6" height="60" />
        <rect x="138" y="75" width="22" height="6" />
        <rect x="138" y="102" width="18" height="6" />
        <rect x="138" y="129" width="22" height="6" />
      </g>

      {/* N — two verticals + diagonal (rightmost block) */}
      <g fill={`url(#${blockId})`}>
        <rect x="166" y="75" width="6" height="60" />
        <rect x="186" y="75" width="6" height="60" />
        <polygon points="172,75 180,75 192,135 184,135" />
      </g>

      {/* Subtle highlight across the top to match the banner's lighter top edge */}
      <rect x="18" y="73" width="174" height="4" fill={`url(#${faceId})`} opacity="0.3" rx="1" />
    </svg>
  );
};

export default QwenLogo;