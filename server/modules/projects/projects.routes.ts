import express from 'express';
import { spawnSync } from 'node:child_process';

import { projectsDb } from '@/modules/database/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { getProjectTaskMaster } from '@/modules/projects/services/projects-has-taskmaster.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';

const router = express.Router();

type AuthenticatedUser = {
  id?: number | string;
};

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

function resolveRouteErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Failed to clone repository';
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
    });
    res.json(projects);
  }),
);

router.get(
  '/archived',
  asyncHandler(async (_req, res) => {
    const projects = await getArchivedProjectsWithSessions();
    res.json(createApiSuccessResponse({ projects }));
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is not supported on create-project', {
        code: 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT',
        statusCode: 400,
        details: 'Use /api/projects/clone-progress for cloning workflows',
      });
    }

    const projectCreationResult = await createProject({
      projectPath,
      customName,
    });

    res.json({
      success: true,
      project: projectCreationResult.project,
      message:
        projectCreationResult.outcome === 'reactivated_archived'
          ? 'Archived project path reused successfully'
          : 'Project created successfully',
    });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

router.get('/clone-progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type: string, data: Record<string, unknown>) => {
    if (res.writableEnded) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let cloneOperation: Awaited<ReturnType<typeof startCloneProject>> | null = null;
  const closeListener = () => {
    cloneOperation?.cancel();
  };
  req.on('close', closeListener);

  try {
    const queryParams = req.query as Record<string, unknown>;
    const workspacePath = readQueryStringValue(queryParams.path);
    const githubUrl = readQueryStringValue(queryParams.githubUrl);
    const githubTokenId = readOptionalNumericQueryValue(queryParams.githubTokenId);
    const newGithubToken = readQueryStringValue(queryParams.newGithubToken) || null;

    const authenticatedUser = (req as typeof req & { user?: AuthenticatedUser }).user;
    const userId = authenticatedUser?.id;
    if (userId === undefined || userId === null) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    cloneOperation = await startCloneProject(
      {
        workspacePath,
        githubUrl,
        githubTokenId,
        newGithubToken,
        userId,
      },
      {
        onProgress: (message) => {
          sendEvent('progress', { message });
        },
        onComplete: ({ project, message }) => {
          sendEvent('complete', { project, message });
        },
      },
    );

    await cloneOperation.waitForCompletion;
  } catch (error) {
    sendEvent('error', { message: resolveRouteErrorMessage(error) });
  } finally {
    req.off('close', closeListener);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

router.get(
  '/:projectId/taskmaster',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const taskMasterDetails = await getProjectTaskMaster(projectId);
    res.json(taskMasterDetails);
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

/**
 * Set (or clear) the GitHub remote URL stored on the project.
 *
 * Body: { url: string | null }
 * - `url` non-empty → stored in `projects.github_remote_url` AND, if the project
 *   is already a git repo, mirrored to `git remote origin` (set-url or add).
 * - `url` null/empty → clears the column. The local `origin` remote is left
 *   alone (don't surprise the user by deleting their manual config).
 *
 * This is the source of truth for "where should this project push to". The
 * `/api/git/init` endpoint also reads from this column when initializing a new
 * repo, so a project that was created locally and later gets a URL here
 * becomes publishable by clicking "Initialize Repository" in the panel.
 */
router.put('/:projectId/github-remote', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const { url } = req.body as { url?: unknown };
    const normalized =
      typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;

    // Basic shape check: accept https://, http://, git@, ssh://. Reject
    // anything that looks like a path or a clearly malformed value so the
    // user gets feedback before they save.
    if (normalized !== null) {
      const looksLikeUrl = /^(https?:\/\/|git@|ssh:\/\/)/i.test(normalized);
      if (!looksLikeUrl) {
        return res.status(400).json({
          error: 'Invalid GitHub URL',
          details: 'Expected an https://, http://, git@, or ssh:// URL.',
        });
      }
    }

    projectsDb.setGithubRemoteUrlById(projectId, normalized);

    // Mirror the new value to the local git remote if the project is already
    // a repo. If it isn't yet a repo, leave the working tree alone — the next
    // time the user clicks "Initialize Repository" we'll wire it up.
    const projectPath = projectsDb.getProjectPathById(projectId);
    let remoteAction: string = 'skipped';
    if (projectPath && normalized !== null) {
      const mirror = mirrorRemoteFromDb(projectPath, normalized);
      remoteAction = mirror.action;
    } else if (projectPath && normalized === null) {
      remoteAction = 'cleared_in_db_remote_untouched';
    }

    res.json({ success: true, url: normalized, remoteAction });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to set GitHub remote' });
  }
});

/**
 * Helper: write `dbUrl` to the local `origin` remote in `projectPath` if the
 * directory is already a git repo. Returns a short action tag the route uses
 * for the response payload.
 *
 * - `add` → no existing origin, `git remote add origin <url>` ran.
 * - `updated` → origin existed with a different URL, `git remote set-url` ran.
 * - `unchanged` → origin already pointed at `dbUrl`.
 * - `not_a_repo` → the path isn't a git repo yet, nothing to do.
 */
function mirrorRemoteFromDb(projectPath: string, dbUrl: string): { action: string; previousUrl?: string } {
  const isRepo = (() => {
    try {
      const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath, encoding: 'buffer' });
      return r.status === 0 && r.stdout.toString().trim() === 'true';
    } catch {
      return false;
    }
  })();
  if (!isRepo) {
    return { action: 'not_a_repo' };
  }

  const existing = (() => {
    try {
      const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath, encoding: 'buffer' });
      return r.status === 0 ? r.stdout.toString().trim() || null : null;
    } catch {
      return null;
    }
  })();

  if (existing === dbUrl) {
    return { action: 'unchanged' };
  }

  if (existing) {
    spawnSync('git', ['remote', 'set-url', 'origin', dbUrl], { cwd: projectPath, encoding: 'buffer' });
    return { action: 'updated', previousUrl: existing };
  }

  spawnSync('git', ['remote', 'add', 'origin', dbUrl], { cwd: projectPath, encoding: 'buffer' });
  return { action: 'add' };
}

router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
