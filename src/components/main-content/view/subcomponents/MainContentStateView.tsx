import { Folder, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MainContentStateViewProps } from '../../types/types';
import { BrandWordmark, Button } from '../../../../shared/view/ui';
import MobileMenuButton from './MobileMenuButton';

export default function MainContentStateView({
  mode,
  isMobile,
  onMenuClick,
  onGoHome,
  onCreateProject,
  onRefresh,
  projects,
  onProjectSelect,
}: MainContentStateViewProps) {
  const { t } = useTranslation();
  const { t: tSidebar } = useTranslation('sidebar');

  const isLoading = mode === 'loading';
  const recentProjects = projects?.slice(0, 3) ?? [];
  const hasRecentProjects = recentProjects.length > 0 && Boolean(onProjectSelect);

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
          <div className="flex items-center gap-2">
            <MobileMenuButton onMenuClick={onMenuClick} compact />
            <button
              type="button"
              onClick={onGoHome}
              className="flex-shrink-0 rounded-md transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('tooltips.goHome')}
              title={t('tooltips.goHome')}
            >
              <BrandWordmark />
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-1 items-center justify-center overflow-y-auto">
          {/* Soft decorative backdrop matching the auth/welcome screens */}
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-primary/5 blur-3xl" />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-lg flex-col items-center gap-6 px-6 py-8 text-center">
            {/* Brand hero — uses the shared BrandWordmark with a larger size for the empty state. */}
            <div className="flex flex-col items-center gap-3">
              <BrandWordmark
                boxSize="h-12 w-12"
                iconSize="h-6 w-6"
                textSize="text-2xl"
              />
              <p className="text-sm text-muted-foreground/80">
                {tSidebar('app.subtitle')}
              </p>
            </div>

            {/* Heading + description */}
            <div className="flex flex-col items-center gap-1">
              <h2 className="text-lg font-semibold text-foreground">
                {t('mainContent.chooseProject')}
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {t('mainContent.selectProjectDescription')}
              </p>
            </div>

            {/* CTAs */}
            {(onCreateProject || onRefresh) && (
              <div className="flex w-full max-w-xs flex-col gap-2">
                {onCreateProject && (
                  <Button onClick={onCreateProject} className="w-full">
                    <Plus className="mr-2 h-4 w-4" />
                    {t('mainContent.createProjectCTA')}
                  </Button>
                )}
                {onRefresh && (
                  <Button
                    variant="outline"
                    onClick={() => void onRefresh()}
                    className="w-full"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('mainContent.refreshProjects')}
                  </Button>
                )}
              </div>
            )}

            {/* Recent projects (only when projects list is non-empty) */}
            {hasRecentProjects && (
              <div className="w-full pt-1">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('mainContent.recentProjects')}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {recentProjects.map((project) => (
                    <button
                      key={project.projectId}
                      onClick={() => onProjectSelect?.(project)}
                      className="group flex flex-col items-start gap-1 rounded-xl border border-border/60 bg-card/60 p-3 text-left transition-colors hover:border-primary/30 hover:bg-card"
                    >
                      <Folder className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
                      <span className="line-clamp-1 w-full text-sm font-medium text-foreground">
                        {project.displayName}
                      </span>
                      <span
                        className="line-clamp-1 w-full text-xs text-muted-foreground/70"
                        title={project.fullPath}
                      >
                        {project.fullPath}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tip block (preserved) */}
            <div className="w-full rounded-xl border border-primary/10 bg-primary/5 p-3 text-left">
              <p className="text-sm text-primary">
                <strong>{t('mainContent.tip')}:</strong>{' '}
                {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}