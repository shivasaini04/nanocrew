// Common generated/vendored directories to skip when a user uploads a whole folder (e.g. a
// codebase). Keeps uploads fast and avoids burning the file-count cap on files the agent has
// no use for anyway (build output, dependencies, VCS internals, caches).
const SKIP_DIR_SEGMENTS = new Set([
    'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', 'target',
    'venv', '.venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.cache',
    'coverage', '.turbo', '.parcel-cache', 'vendor', '.idea', '.vscode',
]);

/** True if a (possibly folder-nested) relative path should be skipped on upload. */
export function shouldSkipUploadPath(relPath: string): boolean {
    return relPath.split(/[\\/]+/).some(seg => SKIP_DIR_SEGMENTS.has(seg));
}
