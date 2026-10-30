// Copied from t3code packages/shared/src/docsCloudProjects.ts at 2ebefb19b7d0be19dc77bdfe5a8b1b8c8714e280.
/**
 * Docs Cloud's projects are T3 Code projects, identified by a key: the user's
 * own git remote such as `github.com/owner/repo`, so every checkout of a
 * repository on every machine shares one project, else `title:` and the
 * normalised title. The T3 server, its clients and Docs Cloud all derive keys
 * here so they agree.
 */

/** Titles compare ignoring case and spacing. */
export const projectNameKey = (name: string): string =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

const TITLE_KEY_PREFIX = "title:";
export const MAX_PROJECT_KEY_LENGTH = 300;

export const titleProjectKey = (name: string): string => TITLE_KEY_PREFIX + projectNameKey(name);

interface ProjectRepository {
  readonly canonicalKey: string;
  readonly rootPath?: string | undefined;
  readonly origin?: { readonly canonicalKey: string } | null | undefined;
}

/**
 * A T3 project's key: the user's own remote. T3's `canonicalKey` prefers the
 * `upstream` remote, so a fork's checkout would join its parent's project;
 * `origin` is set only when it differs from that, and is the fork itself.
 */
export const docsCloudProjectKey = (project: {
  readonly title: string;
  readonly repositoryIdentity?: ProjectRepository | null | undefined;
}): string =>
  project.repositoryIdentity?.origin?.canonicalKey ??
  project.repositoryIdentity?.canonicalKey ??
  titleProjectKey(project.title);

const trimTrailingSeparators = (path: string) => path.replace(/[\\/]+$/, "");

/**
 * One sync entry per key. Several T3 projects can share a repository (its
 * checkout and agent-made projects on worktrees or subfolders), and the name
 * comes from the checkout itself, else the project with the shortest root.
 */
export function docsCloudSyncEntries(
  projects: ReadonlyArray<{
    readonly title: string;
    readonly workspaceRoot: string;
    readonly repositoryIdentity?: ProjectRepository | null | undefined;
  }>,
): ReadonlyArray<{ readonly key: string; readonly name: string }> {
  const rank = (project: (typeof projects)[number]) => {
    const root = trimTrailingSeparators(project.workspaceRoot);
    const repositoryRoot = project.repositoryIdentity?.rootPath;
    const atRoot = repositoryRoot !== undefined && trimTrailingSeparators(repositoryRoot) === root;
    return [atRoot ? 0 : 1, root.length] as const;
  };
  const best = new Map<string, (typeof projects)[number]>();
  for (const project of projects) {
    const key = docsCloudProjectKey(project);
    const current = best.get(key);
    if (current === undefined) {
      best.set(key, project);
      continue;
    }
    const [atRoot, length] = rank(project);
    const [currentAtRoot, currentLength] = rank(current);
    if (atRoot < currentAtRoot || (atRoot === currentAtRoot && length < currentLength)) {
      best.set(key, project);
    }
  }
  return [...best].map(([key, project]) => ({ key, name: project.title.trim() }));
}

/** A key in its stored form (title keys normalised), or null when it is not a usable key. */
export function normalizeProjectKey(key: string): string | null {
  const trimmed = key.trim();
  const normalized = trimmed.toLowerCase().startsWith(TITLE_KEY_PREFIX)
    ? titleProjectKey(trimmed.slice(TITLE_KEY_PREFIX.length))
    : trimmed;
  return normalized.length > 0 &&
    normalized !== TITLE_KEY_PREFIX &&
    normalized.length <= MAX_PROJECT_KEY_LENGTH
    ? normalized
    : null;
}

/** A display name for a key nobody named: the repository or the title. */
export const projectNameFromKey = (key: string): string =>
  key.startsWith(TITLE_KEY_PREFIX)
    ? key.slice(TITLE_KEY_PREFIX.length)
    : (key.split("/").findLast((part) => part.length > 0) ?? key);
