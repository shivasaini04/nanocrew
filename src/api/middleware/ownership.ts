/**
 * Stage 28 — data isolation (Topic 03, Phase 5).
 *
 * Helpers that scope user-owned data to the logged-in account. The auth gate
 * (requireAuth) guarantees req.user exists by the time these run.
 *
 * Model: a user sees ONLY rows whose owner_id is their own id. The admin is treated
 * as a normal owner here (it owns all pre-auth data via the boot backfill); the
 * separate "view as client" support flow is Phase 7, not a blanket god-mode.
 */
import type { Request, Response, NextFunction } from 'express';

/** True if the logged-in user owns the given owner_id. */
export function ownsResource(
  req: Request,
  ownerId: string | null | undefined,
): boolean {
  return !!req.user && !!ownerId && req.user.id === ownerId;
}

/** Keep only the rows owned by the logged-in user. */
export function filterOwned<T extends { owner_id?: string | null }>(
  req: Request,
  rows: T[],
): T[] {
  const uid = req.user?.id;
  return uid ? rows.filter((r) => r.owner_id === uid) : [];
}

/**
 * Build a router.param guard for a root resource. Loads the resource by id, 404s if
 * missing, 403s if the caller doesn't own it, and stashes it on req[attach] so the
 * handler can reuse it. One guard protects every nested /:id/* route on that router.
 *
 *   router.param('id', ownershipParam(getAgent, 'ownedAgent'))
 */
export function ownershipParam<T extends { owner_id?: string | null }>(
  load: (id: string) => T | null | undefined,
  attach: string,
) {
  return (
    req: Request,
    res: Response,
    next: NextFunction,
    id: string,
  ): void => {
    const resource = load(id);
    if (!resource) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!ownsResource(req, resource.owner_id)) {
      // 404 (not 403) so we don't reveal that someone else's resource exists.
      res.status(404).json({ error: 'Not found' });
      return;
    }
    (req as Request & Record<string, unknown>)[attach] = resource;
    next();
  };
}
