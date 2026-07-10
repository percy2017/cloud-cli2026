import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BadgeCheck,
  CircleHelp,
  Coins,
  Cpu,
  Gauge,
  Package,
  Search,
  Server,
  Sparkles,
  TerminalSquare,
  Timer,
  RefreshCw,
  X,
} from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import { CONTEXT_WINDOW } from '../../../../constants/config';
import type { LLMProvider, ProviderModelsCacheInfo, ProviderModelsDefinition } from '../../../../types/app';
import type {
  CommandModalPayload,
  CostCommandData,
  HelpCommandData,
  ModelCommandData,
  StatusCommandData,
} from '../../hooks/useChatComposerState';

type CommandResultModalProps = {
  payload: CommandModalPayload | null;
  onClose: () => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>>;
  providerModelsRefreshing: boolean;
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  onSelectProviderModel: (
    provider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => Promise<{
    scope: 'default' | 'session';
    changed: boolean;
    model: string;
  }>;
};

type CommandEntry = {
  name: string;
  description?: string;
  namespace?: string;
};

type ModelOption = {
  value: string;
  label?: string;
  description?: string;
};

// Built-in command catalogue — descriptions come from the server, but when
// the server returns an empty payload we surface a localized fallback list.
const FALLBACK_COMMANDS = (t: (key: string) => string): CommandEntry[] => [
  { name: '/models', description: t('commandModal.fallbackCommands.models') },
  { name: '/cost', description: t('commandModal.fallbackCommands.cost') },
  { name: '/status', description: t('commandModal.fallbackCommands.status') },
  { name: '/memory', description: t('commandModal.fallbackCommands.memory') },
  { name: '/config', description: t('commandModal.fallbackCommands.config') },
  { name: '/help', description: t('commandModal.fallbackCommands.help') },
];

const getProviderLabel = (
  provider: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string => {
  if (!provider) {
    return t('commandModal.common.providerUnknown');
  }
  const translated = t(`commandModal.providers.${provider}`, { defaultValue: '' });
  return translated || provider;
};

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
};

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  compact = false,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  tone?: 'neutral' | 'primary' | 'success';
  compact?: boolean;
}) {
  const toneClass =
    tone === 'primary'
      ? 'border-primary/35 bg-primary/10 text-primary'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
        : 'border-border/70 bg-background/75 text-muted-foreground';

  return (
    <div
      className={`group rounded-2xl border border-border/70 bg-background/75 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      <div className={`inline-flex rounded-xl border ${compact ? 'mb-2 p-1.5' : 'mb-3 p-2'} ${toneClass}`}>
        <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`${compact ? 'mt-0.5 text-[13px]' : 'mt-1 text-sm'} break-all font-semibold text-foreground`}>{value}</p>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-xl border-border/70 bg-background/75 pl-9 pr-3 shadow-none focus-visible:ring-primary/40"
      />
    </div>
  );
}

function HelpContent({ data }: { data: HelpCommandData }) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const commands = (Array.isArray(data.commands) && data.commands.length > 0
    ? data.commands
    : FALLBACK_COMMANDS(t)) as CommandEntry[];

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return commands;
    }

    return commands.filter((command) => {
      const haystack = `${command.name} ${command.description || ''} ${command.namespace || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [commands, query]);

  const noDescription = t('commandModal.common.noDescription');
  const builtin = t('commandModal.common.builtin');

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-h-0 flex-col gap-3">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('commandModal.help.searchPlaceholder')}
        />

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-2 sm:grid-cols-2">
            {filteredCommands.map((command, index) => (
              <div
                key={`${command.namespace || 'builtin'}-${command.name}`}
                className="settings-content-enter rounded-2xl border border-border/70 bg-background/75 p-3 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-muted/25"
                style={{ animationDelay: `${Math.min(index * 18, 160)}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <code className="rounded-lg border border-primary/20 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                    {command.name}
                  </code>
                  <Badge variant="secondary" className="shrink-0 text-[10px] capitalize">
                    {command.namespace || builtin}
                  </Badge>
                </div>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  {command.description || noDescription}
                </p>
              </div>
            ))}
          </div>

          {filteredCommands.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
              {t('commandModal.help.noMatch')}
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TerminalSquare className="h-4 w-4 text-primary" />
            {t('commandModal.help.syntaxHeading')}
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p><code className="text-foreground">{t('commandModal.help.syntaxLineCommand')}</code></p>
            <p><code className="text-foreground">$ARGUMENTS</code> {t('commandModal.help.syntaxLineArguments').replace(/^\$ARGUMENTS\s*/, '')}</p>
            <p>{t('commandModal.help.syntaxLinePositional').replace(/^\$1,\s*\$2\s*/, '$1, $2 ')}</p>
            <p>{t('commandModal.help.syntaxLineFile')}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-primary/25 bg-primary/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('commandModal.help.quickTipHeading')}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t('commandModal.help.quickTipBody')}
          </p>
        </div>
      </aside>
    </div>
  );
}

function ModelsContent({
  data,
  providerModelCatalog,
  providerModelsRefreshing,
  onHardRefreshProviderModels,
  currentSessionId,
  onSelectProviderModel,
}: {
  data: ModelCommandData;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsRefreshing: boolean;
  onHardRefreshProviderModels: () => void;
  currentSessionId: string | null;
  onSelectProviderModel: CommandResultModalProps['onSelectProviderModel'];
}) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [changingModel, setChangingModel] = useState<string | null>(null);
  const [pendingSessionModel, setPendingSessionModel] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const currentProvider = (data?.current?.provider || 'claude') as LLMProvider;
  const providerLabel = getProviderLabel(currentProvider, t);
  const liveDefinition = providerModelCatalog[currentProvider];
  const availableOptions = useMemo<ModelOption[]>(() => {
    if (liveDefinition?.OPTIONS && liveDefinition.OPTIONS.length > 0) {
      return liveDefinition.OPTIONS;
    }

    if (Array.isArray(data?.availableOptions) && data.availableOptions.length > 0) {
      return data.availableOptions;
    }

    const availableModels = Array.isArray(data?.availableModels) ? data.availableModels : [];
    return availableModels.map((model) => ({ value: model, label: model }));
  }, [data, liveDefinition]);

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return availableOptions;
    }

    return availableOptions.filter((option) => {
      const haystack = `${option.value} ${option.label || ''} ${option.description || ''}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [availableOptions, query]);

  const hasConcreteSessionId = typeof currentSessionId === 'string' && currentSessionId.trim().length > 0;
  const showSearch = availableOptions.length > 6;

  const handleSelectModel = async (model: string) => {
    setChangingModel(model);
    try {
      const result = await onSelectProviderModel(currentProvider, model, currentSessionId);
      if (result.scope === 'session') {
        setPendingSessionModel(result.model);
        setSelectionNotice(t('commandModal.models.noticeSession', { model: result.model }));
        return;
      }

      setPendingSessionModel(null);
      setSelectionNotice(
        t('commandModal.models.noticeDefault', { provider: providerLabel, model: result.model }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : t('commandModal.models.noticeError');
      setSelectionNotice(message);
    } finally {
      setChangingModel(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Compact context bar: active model + refresh, no clutter */}
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {t('commandModal.models.activeModel', { provider: providerLabel })}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-all font-mono text-sm font-semibold text-foreground">
              {data?.current?.model || t('commandModal.common.providerUnknown')}
            </span>
            {pendingSessionModel && pendingSessionModel !== data?.current?.model && (
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-500 dark:text-emerald-400">
                → {pendingSessionModel} {t('commandModal.models.appliesNextResponse').toLowerCase()}
              </span>
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onHardRefreshProviderModels}
          disabled={providerModelsRefreshing}
          title={t('commandModal.models.refreshTitle')}
          aria-label={t('commandModal.models.refreshAriaLabel')}
          className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-4 w-4 ${providerModelsRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {showSearch && (
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('commandModal.models.searchPlaceholder', { provider: providerLabel })}
        />
      )}

      {filteredOptions.length > 0 ? (
        <div className="scrollbar-thin -mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-2 md:grid-cols-2">
            {filteredOptions.map((option, index) => {
              const isCurrent = option.value === data?.current?.model;
              const isPendingSelection = option.value === pendingSessionModel;
              const isChanging = option.value === changingModel;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelectModel(option.value)}
                  disabled={Boolean(changingModel)}
                  aria-label={t('commandModal.models.selectModelAria', { model: option.value })}
                  className={`settings-content-enter group flex min-h-[4rem] flex-col rounded-2xl border p-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 ${
                    isCurrent
                      ? 'border-primary/45 bg-primary/10'
                      : isPendingSelection
                        ? 'border-emerald-500/35 bg-emerald-500/10'
                        : 'border-border/70 bg-background/80 hover:border-primary/30 hover:bg-background'
                  }`}
                  style={{ animationDelay: `${Math.min(index * 14, 180)}ms` }}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="break-all font-mono text-sm font-semibold text-foreground">{option.value}</span>
                    {isCurrent ? (
                      <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />
                    ) : isChanging ? (
                      <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    ) : null}
                  </span>
                  {option.label && option.label !== option.value && (
                    <span className="mt-1 text-xs font-medium text-foreground/85">{option.label}</span>
                  )}
                  {option.description && (
                    <span className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</span>
                  )}
                  {isCurrent && (
                    <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                      {t('commandModal.models.currentSelection')}
                    </span>
                  )}
                  {isPendingSelection && !isCurrent && (
                    <span className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-500 dark:text-emerald-400">
                      {t('commandModal.models.appliesNextResponse')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-background/60 px-4 py-10 text-center text-sm text-muted-foreground">
          {t('commandModal.models.noMatch')}
        </div>
      )}

      {/* Single quiet line of guidance / feedback */}
      <p className="shrink-0 text-[11px] leading-4 text-muted-foreground">
        {selectionNotice ? (
          <span className="text-foreground">{selectionNotice}</span>
        ) : hasConcreteSessionId ? (
          t('commandModal.models.hasConcreteSession')
        ) : (
          t('commandModal.models.noConcreteSession')
        )}
      </p>
    </div>
  );
}

function CostContent({ data }: { data: CostCommandData }) {
  const { t } = useTranslation('chat');
  const used = Number(data.tokenUsage?.used ?? 0);
  const reportedTotal = Number(data.tokenUsage?.total ?? 0);
  // Backend may not populate `total` (gemini/opencode omit it; cursor/qwen
  // report 0 + unsupported). Fall back to the operator-configured
  // VITE_CONTEXT_WINDOW so the row always shows a real, .env-sourced number.
  const total = reportedTotal > 0 ? reportedTotal : CONTEXT_WINDOW;
  const model = data.model || t('commandModal.common.providerUnknown');
  const provider = getProviderLabel(data.provider, t);
  const hasBreakdown =
    typeof data.tokenBreakdown?.input === 'number' ||
    typeof data.tokenBreakdown?.output === 'number';
  const breakdownUnavailable = t('commandModal.cost.breakdownUnavailable');
  const usageRows = [
    { label: t('commandModal.cost.totalUsed'), value: formatNumber(used), icon: Activity },
    ...(hasBreakdown
      ? [
          {
            label: t('commandModal.cost.inputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.input ?? 0)),
            icon: TerminalSquare,
          },
          {
            label: t('commandModal.cost.outputTokens'),
            value: formatNumber(Number(data.tokenBreakdown?.output ?? 0)),
            icon: Coins,
          },
        ]
      : [
          {
            label: t('commandModal.cost.breakdown'),
            value: breakdownUnavailable,
            icon: TerminalSquare,
          },
        ]),
    ...(total > 0
      ? [{ label: t('commandModal.cost.contextWindow'), value: formatNumber(total), icon: Gauge }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/75">
        {usageRows.map((row) => {
          const Icon = row.icon;

          return (
            <div
              key={row.label}
              className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
              </div>
              <span className="shrink-0 font-mono text-sm font-semibold text-foreground">{row.value}</span>
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('commandModal.cost.provider')}
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">{provider}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('commandModal.cost.model')}
            </p>
            <p className="mt-1 break-all font-mono text-sm text-foreground">{model}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusContent({ data }: { data: StatusCommandData }) {
  const { t } = useTranslation('chat');
  const memoryRssMb = data.memoryUsage?.rssMb;
  const rows = [
    { label: t('commandModal.status.package'), value: data.packageName || 'claude-code-ui', icon: Package },
    { label: t('commandModal.status.version'), value: data.version || t('commandModal.common.providerUnknown'), icon: BadgeCheck, tone: 'success' as const },
    { label: t('commandModal.status.uptime'), value: data.uptime || t('commandModal.common.providerUnknown'), icon: Timer },
    { label: t('commandModal.status.provider'), value: getProviderLabel(data.provider, t), icon: Server, tone: 'primary' as const },
    { label: t('commandModal.status.model'), value: data.model || t('commandModal.common.providerUnknown'), icon: Cpu },
    { label: t('commandModal.status.node'), value: data.nodeVersion || t('commandModal.common.providerUnknown'), icon: TerminalSquare },
    { label: t('commandModal.status.platform'), value: data.platform || t('commandModal.common.providerUnknown'), icon: Activity },
    {
      label: t('commandModal.status.memory'),
      value: typeof memoryRssMb === 'number'
        ? t('commandModal.status.memoryValue', { mb: memoryRssMb })
        : t('commandModal.status.memoryUnknown'),
      icon: Gauge,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-3xl border border-emerald-500/25 bg-emerald-500/10 p-4">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('commandModal.status.onlineHeading')}</p>
            <p className="text-xs text-muted-foreground">
              {data.pid
                ? t('commandModal.status.onlineBody', { pid: `#${data.pid}` })
                : t('commandModal.status.onlineBodyNoPid')}
            </p>
          </div>
        </div>
        <Badge className="rounded-full bg-emerald-500 text-white hover:bg-emerald-500">
          {t('commandModal.status.healthy')}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <MetricCard key={row.label} label={row.label} value={String(row.value)} icon={row.icon} tone={row.tone} />
        ))}
      </div>
    </div>
  );
}

export default function CommandResultModal({
  payload,
  onClose,
  providerModelCatalog,
  providerModelsRefreshing,
  onHardRefreshProviderModels,
  currentSessionId,
  onSelectProviderModel,
}: CommandResultModalProps) {
  const { t } = useTranslation('chat');
  const isOpen = Boolean(payload);
  const kind = payload?.kind;
  const isModelsModal = kind === 'models';

  const modalMeta = {
    help: {
      eyebrow: t('commandModal.help.eyebrow'),
      title: t('commandModal.help.title'),
      subtitle: t('commandModal.help.subtitle'),
      icon: CircleHelp,
    },
    models: {
      eyebrow: t('commandModal.models.eyebrow'),
      title: t('commandModal.models.title'),
      subtitle: t('commandModal.models.subtitle'),
      icon: Cpu,
    },
    cost: {
      eyebrow: t('commandModal.cost.eyebrow'),
      title: t('commandModal.cost.title'),
      subtitle: t('commandModal.cost.subtitle'),
      icon: Coins,
    },
    status: {
      eyebrow: t('commandModal.status.eyebrow'),
      title: t('commandModal.status.title'),
      subtitle: t('commandModal.status.subtitle'),
      icon: Activity,
    },
  } as const;

  const activeMeta = kind ? modalMeta[kind] : null;
  const HeaderIcon = activeMeta?.icon || Sparkles;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(92dvh,48rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl sm:w-[min(94vw,64rem)]">
        <DialogTitle>{activeMeta?.title || t('commandModal.common.close')}</DialogTitle>

        <div
          className={`flex shrink-0 items-start justify-between gap-3 border-b border-border bg-popover ${
            isModelsModal ? 'px-4 py-3 sm:px-5 sm:py-4' : 'px-4 py-4 sm:px-6 sm:py-5'
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={`flex shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground ${
                isModelsModal ? 'h-9 w-9' : 'h-10 w-10'
              }`}
            >
              <HeaderIcon className={isModelsModal ? 'h-4 w-4' : 'h-5 w-5'} />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {activeMeta?.eyebrow}
              </p>
              <p className="mt-0.5 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {activeMeta?.title}
              </p>
              <p className="mt-0.5 max-w-2xl text-sm leading-5 text-muted-foreground">
                {activeMeta?.subtitle}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('commandModal.common.closeAriaLabel')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="settings-content-enter min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
          {payload?.kind === 'help' && <HelpContent data={payload.data as HelpCommandData} />}
          {payload?.kind === 'models' && (
            <ModelsContent
              data={payload.data as ModelCommandData}
              providerModelCatalog={providerModelCatalog}
              providerModelsRefreshing={providerModelsRefreshing}
              onHardRefreshProviderModels={onHardRefreshProviderModels}
              currentSessionId={currentSessionId}
              onSelectProviderModel={onSelectProviderModel}
            />
          )}
          {payload?.kind === 'cost' && <CostContent data={payload.data as CostCommandData} />}
          {payload?.kind === 'status' && <StatusContent data={payload.data as StatusCommandData} />}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5" />
            <span>{t('commandModal.common.escCloses')}</span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose} className="rounded-xl">
            {t('commandModal.common.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
