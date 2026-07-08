import { useTranslation } from 'react-i18next';

import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '../../../constants/branding';

type BrandWordmarkProps = {
  /** Tailwind size class for the inner icon SVG, default `'h-3.5 w-3.5'`. */
  iconSize?: string;
  /** Tailwind size class for the colored square that wraps the icon, default `'h-7 w-7'`. */
  boxSize?: string;
  /** Tailwind size class for the wordmark `<h1>`, default `'text-sm'`. */
  textSize?: string;
  /** Optional className for the root `<div>`. */
  className?: string;
  /**
   * When true, renders only the colored-square icon — no wordmark text.
   * Useful for compact contexts where the brand text would overflow.
   */
  iconOnly?: boolean;
};

/**
 * Shared brand wordmark for CloudCLI — the chat-bubble glyph in a primary-colored
 * square plus the bold "CloudCLI" wordmark using the brand font stack.
 *
 * Replaces the inline `LogoBlock` that previously lived inside `SidebarHeader`,
 * and is reused in the mobile-only header strips of the main content area.
 */
export default function BrandWordmark({
  iconSize = 'h-3.5 w-3.5',
  boxSize = 'h-7 w-7',
  textSize = 'text-sm',
  className,
  iconOnly = false,
}: BrandWordmarkProps) {
  const { t } = useTranslation('sidebar');

  return (
    <div className={`flex min-w-0 items-center gap-2.5${className ? ` ${className}` : ''}`}>
      <div
        className={`flex ${boxSize} flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm`}
      >
        <svg
          className={`${iconSize} text-primary-foreground`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      {!iconOnly && (
        <h1
          className={`truncate font-bold tracking-tight text-foreground ${textSize}`}
          style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
        >
          {t('app.title')}
        </h1>
      )}
    </div>
  );
}