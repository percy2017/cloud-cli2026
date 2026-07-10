import type { LLMProvider } from '../../../../types/app';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';
import { useTranslation } from 'react-i18next';

import { useEnabledProviders } from '../../../providers/useEnabledProviders';
import AgentConnectionCard from './AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  const { t } = useTranslation('settings');
  const { enabled: providerKeys, cardStyles } = useEnabledProviders();

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
          const styles = cardStyles[provider];
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