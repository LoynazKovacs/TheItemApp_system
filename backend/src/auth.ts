import type { FastifyRequest, FastifyReply } from 'fastify';

export interface AuthContext {
  ok: boolean;
  userId: string | null;
  groupIds: string[];
}

/**
 * Verify the caller against core by forwarding their Authorization/Cookie to
 * `/api/auth/me`. Requests reach this backend through core's `/system-api`
 * proxy, which forwards the user's session, so the user's real identity and
 * group membership are available here.
 */
export async function verifyCaller(coreApiUrl: string, req: FastifyRequest): Promise<AuthContext> {
  const authorization = (req.headers['authorization'] as string | undefined) ?? '';
  const cookie = (req.headers['cookie'] as string | undefined) ?? '';
  if (!authorization && !cookie) return { ok: false, userId: null, groupIds: [] };
  try {
    const res = await fetch(`${coreApiUrl.replace(/\/$/, '')}/api/auth/me`, {
      method: 'GET',
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) return { ok: false, userId: null, groupIds: [] };
    const me = (await res.json()) as any;
    const user = me?.user ?? me;
    const groupIds = Array.isArray(user?.groupIds)
      ? user.groupIds.map((g: any) => (typeof g === 'string' ? g : String(g?._id ?? ''))).filter(Boolean)
      : [];
    return { ok: true, userId: String(user?._id ?? '') || null, groupIds };
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
