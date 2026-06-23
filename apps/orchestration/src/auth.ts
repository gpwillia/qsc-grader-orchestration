import jwt from 'jsonwebtoken';
import type { Context, Next } from 'hono';
import type { AuthUser } from '@qsc/contracts';
import type { OrchestrationStore } from './db.js';

export interface JwtClaims {
  sub: string;
  role: AuthUser['role'];
  email: string;
}

export function signAccessToken(user: AuthUser, secret: string, expiresIn: string): string {
  return jwt.sign({ role: user.role, email: user.email }, secret, {
    subject: user.id,
    expiresIn: expiresIn as jwt.SignOptions['expiresIn']
  });
}

export function verifyAccessToken(token: string, secret: string): JwtClaims {
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload;

  if (!decoded.sub || !decoded.role || !decoded.email) {
    throw new Error('Invalid token payload');
  }

  return {
    sub: decoded.sub,
    role: decoded.role as AuthUser['role'],
    email: decoded.email as string
  };
}

export async function requireAuth(
  c: Context,
  next: Next,
  store: OrchestrationStore,
  jwtSecret: string
): Promise<Response | void> {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing Bearer token' }, 401);
  }

  const token = auth.slice('Bearer '.length);

  let claims: JwtClaims;
  try {
    claims = verifyAccessToken(token, jwtSecret);
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }

  const user = await store.getUserById(claims.sub);
  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  c.set('authUser', user);
  await next();
}

export function requireAdmin(c: Context): Response | null {
  const user = c.get('authUser') as AuthUser | undefined;
  if (!user || user.role !== 'ADMIN') {
    return c.json({ error: 'Admin role required' }, 403);
  }

  return null;
}
