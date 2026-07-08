import { useCallback, useMemo, useState } from 'react';
import { useGitPanelController } from '../hooks/useGitPanelController';
import { useRevertLocalCommit } from '../hooks/useRevertLocalCommit';
import type { ConfirmationRequest, GitPanelProps, GitPanelView } from '../types/types';
import { getChangedFileCount } from '../utils/gitPanelUtils';
import ChangesView from '../view/changes/ChangesView';
import HistoryView from '../view/history/HistoryView';
import BranchesView from '../view/branches/BranchesView';
import GitPanelHeader from '../view/GitPanelHeader';
import GitRepositoryErrorState from '../view/GitRepositoryErrorState';
import GitViewTabs from '../view/GitViewTabs';
import ConfirmActionModal from '../view/modals/ConfirmActionModal';

export default function GitPanel({ selectedProject, isMobile = false, onFileOpen }: GitPanelProps) {
  // `selectedProject` from `useProjectsState` is rebuilt on every
  // `session_upserted` (the server pushes per-session deltas on every Claude
  // tool call), so the project object identity changes once per tool call
  // even when the user is sitting on the git tab doing nothing. That cascade
  // re-runs every useEffect in the controller and re-fetches `/api/git/status`
  // on each tool invocation.
  //
  // Stabilize the project shape we hand to the controller by stripping the
  // `sessions` array (the only field that mutates with every event). Once
  // `projectId`/`fullPath` are stable, all the `useEffect(..., [projectId,
  // fullPath])` hooks in the controller stay quiet.
  const stableProject = useMemo(() => {
    if (!selectedProject) return null;
    return {
      ...selectedProject,
      sessions: [], // intentionally empty; the git panel never reads them
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.projectId, selectedProject?.fullPath]);

  const [activeView, setActiveView] = useState<GitPanelView>('changes');
  const [wrapText, setWrapText] = useState(true);
  const [hasExpandedFiles, setHasExpandedFiles] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmationRequest | null>(null);

  const {
    gitStatus,
    gitDiff,
    isLoading,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializing,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  } = useGitPanelController({
    selectedProject: stableProject,
    activeView,
    onFileOpen,
  });

  const { isRevertingLocalCommit, revertLatestLocalCommit } = useRevertLocalCommit({
    // `projectId` (DB primary key) is forwarded to the revert API which uses it
    // as the `project` body param.
    projectId: stableProject?.projectId ?? null,
    onSuccess: refreshAll,
  });

  const executeConfirmedAction = useCallback(async () => {
    if (!confirmAction) return;
    const actionToExecute = confirmAction;
    setConfirmAction(null);
    try {
      await actionToExecute.onConfirm();
    } catch (error) {
      console.error('Error executing confirmation action:', error);
    }
  }, [confirmAction]);

  const changeCount = getChangedFileCount(gitStatus);

  if (!stableProject) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Select a project to view source control</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <GitPanelHeader
        isMobile={isMobile}
        currentBranch={currentBranch}
        branches={branches}
        remoteStatus={remoteStatus}
        isLoading={isLoading}
        isCreatingBranch={isCreatingBranch}
        isFetching={isFetching}
        isPulling={isPulling}
        isPushing={isPushing}
        isPublishing={isPublishing}
        isRevertingLocalCommit={isRevertingLocalCommit}
        operationError={operationError}
        onRefresh={refreshAll}
        onRevertLocalCommit={revertLatestLocalCommit}
        onSwitchBranch={switchBranch}
        onCreateBranch={createBranch}
        onFetch={handleFetch}
        onPull={handlePull}
        onPush={handlePush}
        onPublish={handlePublish}
        onClearError={clearOperationError}
        onRequestConfirmation={setConfirmAction}
      />

      {gitStatus?.error ? (
        <GitRepositoryErrorState
          error={gitStatus.error}
          details={gitStatus.details}
          onInit={initRepository}
          isInitializing={isInitializing}
        />
      ) : (
        <>
          <GitViewTabs
            activeView={activeView}
            isHidden={hasExpandedFiles}
            changeCount={changeCount}
            onChange={setActiveView}
          />

          {activeView === 'changes' && (
            <ChangesView
              key={stableProject.fullPath}
              isMobile={isMobile}
              projectPath={stableProject.fullPath}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              isLoading={isLoading}
              wrapText={wrapText}
              isCreatingInitialCommit={isCreatingInitialCommit}
              onWrapTextChange={setWrapText}
              onCreateInitialCommit={createInitialCommit}
              onOpenFile={openFile}
              onDiscardFile={discardChanges}
              onDeleteFile={deleteUntrackedFile}
              onCommitChanges={commitChanges}
              onGenerateCommitMessage={generateCommitMessage}
              onRequestConfirmation={setConfirmAction}
              onExpandedFilesChange={setHasExpandedFiles}
            />
          )}

          {activeView === 'history' && (
            <HistoryView
              isMobile={isMobile}
              isLoading={isLoading}
              recentCommits={recentCommits}
              commitDiffs={commitDiffs}
              wrapText={wrapText}
              onFetchCommitDiff={fetchCommitDiff}
            />
          )}

          {activeView === 'branches' && (
            <BranchesView
              isMobile={isMobile}
              isLoading={isLoading}
              currentBranch={currentBranch}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              remoteStatus={remoteStatus}
              isCreatingBranch={isCreatingBranch}
              onSwitchBranch={switchBranch}
              onCreateBranch={createBranch}
              onDeleteBranch={deleteBranch}
              onRequestConfirmation={setConfirmAction}
            />
          )}
        </>
      )}

      <ConfirmActionModal
        action={confirmAction}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          void executeConfirmedAction();
        }}
      />
    </div>
  );
}
