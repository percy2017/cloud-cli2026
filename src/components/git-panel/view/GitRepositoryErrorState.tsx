import { GitBranch, GitFork } from 'lucide-react';

type GitRepositoryErrorStateProps = {
  error: string;
  details?: string;
  onInit?: () => void;
  isInitializing?: boolean;
};

export default function GitRepositoryErrorState({ error, details, onInit, isInitializing = false }: GitRepositoryErrorStateProps) {
  // The backend sometimes wraps the original message in "Git operation failed"
// (when its case-sensitive substring check misses "Not..." vs "not..."),
// while the underlying "Not a git repository…" sentence ends up in `details`.
// Match against both fields with a case-insensitive regex so the button shows
// regardless of which branch the backend took.
const showInitButton = Boolean(onInit) && /not a git repository/i.test(`${error} ${details ?? ''}`);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-muted-foreground">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
        <GitBranch className="h-8 w-8 opacity-40" />
      </div>
      <h3 className="mb-3 text-center text-lg font-medium text-foreground">{error}</h3>
      {details && (
        <p className="mb-6 max-w-md text-center text-sm leading-relaxed">{details}</p>
      )}
      <div className="max-w-md rounded-xl border border-primary/10 bg-primary/5 p-4">
        <p className="text-center text-sm text-primary">
          <strong>Tip:</strong> Run{' '}
          <code className="rounded-md bg-primary/10 px-2 py-1 font-mono text-xs">git init</code>{' '}
          in your project directory to initialize git source control.
        </p>
      </div>
      {showInitButton && (
        <button
          type="button"
          onClick={onInit}
          disabled={isInitializing}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <GitFork className="h-4 w-4" />
          {isInitializing ? 'Initializing…' : 'Initialize Repository'}
        </button>
      )}
    </div>
  );
}