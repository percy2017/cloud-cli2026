import type { LLMProvider } from '../../../../types/app';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';
import { useTranslation } from 'react-i18next';

import AgentConnectionCard from './AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

const providerCardStyles = {
  claude: {
    connectedClassName: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    iconContainerClassName: 'bg-blue-100 dark:bg-blue-900/30',
    loginButtonClassName: 'bg-blue-600 hover:bg-blue-700',
  },
  cursor: {
    connectedClassName: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',
    iconContainerClassName: 'bg-purple-100 dark:bg-purple-900/30',
    loginButtonClassName: 'bg-purple-600 hover:bg-purple-700',
  },
  codex: {
    connectedClassName: 'bg-gray-100 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600',
    iconContainerClassName: 'bg-gray-100 dark:bg-gray-800',
    loginButtonClassName: 'bg-gray-800 hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600',
  },
  gemini: {
    connectedClassName: 'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800',
    iconContainerClassName: 'bg-teal-100 dark:bg-teal-900/30',
    loginButtonClassName: 'bg-teal-600 hover:bg-teal-700',
  },
  opencode: {
    connectedClassName: 'bg-zinc-100 dark:bg-zinc-800/50 border-zinc-300 dark:border-zinc-600',
    iconContainerClassName: 'bg-zinc-100 dark:bg-zinc-800',
    loginButtonClassName: 'bg-zinc-800 hover:bg-zinc-900 dark:bg-zinc-700 dark:hover:bg-zinc-600',
  },
} as const;

const providerKeys: Array<keyof typeof providerCardStyles> = ['claude', 'cursor', 'codex', 'gemini', 'opencode'];

export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">
          {t('onboarding.agents.title')}
        </h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {t('onboarding.agents.description')}
        </p>
      </div>

      <div className="-mr-1 max-h-[38vh] space-y-2 overflow-y-auto pr-1">
        {providerKeys.map((provider) => {
          const styles = providerCardStyles[provider];
          return (
            <AgentConnectionCard
              key={provider}
              provider={provider}
              title={t(`onboarding.agents.providerTitles.${provider}`)}
              status={providerStatuses[provider]}
              connectedClassName={styles.connectedClassName}
              iconContainerClassName={styles.iconContainerClassName}
              loginButtonClassName={styles.loginButtonClassName}
              onLogin={() => onOpenProviderLogin(provider)}
            />
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {t('onboarding.agents.footerNote')}
      </p>
    </div>
  );
}