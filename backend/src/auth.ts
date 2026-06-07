import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyUser } from '@loynazkovacs/theitemapp-backend-sdk';

export interface AuthContext {
  ok: boolean;
  userId: string | null;
  groupIds: string[];
}

/**
 * Verify the caller against core by forwarding their Authorization/Cookie to
 * `/api/auth/me`, via the shared backend SDK's `verifyUser`. Requests reach
 * this backend through core's `/system-api` proxy, which forwards the user's
 * session, so the user's real identity and group membership are available here.
 *
 * Core being unreachable is treated as "not authenticated" (ok:false → 401),
 * preserving this app's previous behaviour.
 */
export async function verifyCaller(coreApiUrl: string, req: FastifyRequest): Promise<AuthContext> {
  try {
    const user = await verifyUser(coreApiUrl, {
      cookie: req.headers['cookie'] as string | undefined,
      authorization: req.headers['authorization'] as string | undefined,
    });
    if (!user) return { ok: false, userId: null, groupIds: [] };
    return { ok: true, userId: user._id, groupIds: user.groupIds };
  } catch {
    return { ok: false, userId: null, groupIds: [] };
  }
}

export function makeRequireAuth(coreApiUrl: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await verifyCaller(coreApiUrl, req);
    if (!ctx.ok) {
      await reply.code(401).send({ ok: false, error: 'Unauthorized' });
      return;
    }
    (req as any).authCtx = ctx;
  };
}

export function makeRequireAdmin(coreApiUrl: string, adminGroupId: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await verifyCaller(coreApiUrl, req);
    if (!ctx.ok) {
      await reply.code(401).send({ ok: false, error: 'Unauthorized' });
      return;
    }
    if (!ctx.groupIds.includes(adminGroupId)) {
      await reply.code(403).send({ ok: false, error: 'Admin group required for container control' });
      return;
    }
    (req as any).authCtx = ctx;
  };
}
