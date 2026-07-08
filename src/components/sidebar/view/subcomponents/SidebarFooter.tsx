import { Settings, AlertTriangle, LogOut } from 'lucide-react';
import type { TFunction } from 'i18next';

import { IS_PLATFORM } from '../../../../constants/config';

type SidebarFooterProps = {
  restartRequired: boolean;
  onShowSettings: () => void;
  onLogout: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  restartRequired,
  onShowSettings,
  onLogout,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {/* Restart-required banner: the running server version differs from the
          installed/frontend version (updated but not restarted). */}
      {restartRequired && (
        <>
          <div className="nav-divider" />
          <div className="px-2 py-1.5 md:px-2 md:py-1.5">
            <div className="flex items-center gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50/80 px-2.5 py-2 dark:border-amber-700/40 dark:bg-amber-900/15">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400" />
              <span className="min-w-0 flex-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                {t('version.restartRequired')}
              </span>
            </div>
          </div>
        </>
      )}

      <div className="nav-divider" />

      {/* Desktop settings */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-2 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Sign out (self-hosted only — IS_PLATFORM has no local session) */}
      {!IS_PLATFORM && (
        <>
          <div className="nav-divider" />

          {/* Desktop sign out */}
          <div className="hidden px-2 py-1.5 md:block">
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              onClick={onLogout}
              aria-label={t('auth:logout.button')}
              title={t('auth:logout.button')}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="text-sm">{t('auth:logout.button')}</span>
            </button>
          </div>

          {/* Mobile sign out */}
          <div className="px-3 pb-3 pt-2 md:hidden">
            <button
              className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
              onClick={onLogout}
              aria-label={t('auth:logout.button')}
              title={t('auth:logout.button')}
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
                <LogOut className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="text-sm font-normal text-foreground">{t('auth:logout.button')}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
