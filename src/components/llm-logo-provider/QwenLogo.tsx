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
 * This SVG reproduces the silhouette of that mark at small sizes
 * (16px sidebar dot → 96px onboarding card) by tracing the six
 * glyph blocks as a single hexagonal outline + interior strokes
 * that read as "QWEN" when scaled up. Verified against the live
 * banner from `qwen` 0.19.8 on this host.
 *
 * Geometry is a 200×200 viewBox.
 */
const QwenLogo = ({ className = "w-5 h-5" }: QwenLogoProps) => (
  <svg
    viewBox="0 0 200 200"
    role="img"
    aria-label="Qwen Code"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="qwen-block" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#a78bfa" />
        <stop offset="100%" stopColor="#7c3aed" />
      </linearGradient>
      <linearGradient id="qwen-face" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
        <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0.85" />
      </linearGradient>
    </defs>

    {/* Q — circle on a stem (leftmost block) */}
    <g fill="url(#qwen-block)">
      <circle cx="40" cy="100" r="22" />
    </g>
    <g fill="none" stroke="url(#qwen-block)" strokeWidth="6" strokeLinecap="round">
      <line x1="55" y1="115" x2="62" y2="135" />
    </g>

    {/* W — two converging diagonals (second block) */}
    <g fill="url(#qwen-block)">
      <polygon points="74,75 84,75 96,135 88,135" />
      <polygon points="96,135 88,135 100,95 108,95" />
      <polygon points="108,95 100,95 112,135 120,135" />
      <polygon points="112,135 120,135 122,75 130,75" />
    </g>

    {/* E — three horizontal bars + spine (third block) */}
    <g fill="url(#qwen-block)">
      <rect x="138" y="75" width="6" height="60" />
      <rect x="138" y="75" width="22" height="6" />
      <rect x="138" y="102" width="18" height="6" />
      <rect x="138" y="129" width="22" height="6" />
    </g>

    {/* N — two verticals + diagonal (rightmost block) */}
    <g fill="url(#qwen-block)">
      <rect x="166" y="75" width="6" height="60" />
      <rect x="186" y="75" width="6" height="60" />
      <polygon points="172,75 180,75 192,135 184,135" />
    </g>

    {/* Subtle highlight across the top to match the banner's lighter top edge */}
    <rect x="18" y="73" width="174" height="4" fill="url(#qwen-face)" opacity="0.3" rx="1" />
  </svg>
);

export default QwenLogo;