import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.ts';

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'govtrack-local-dev-secret-change-in-prod';

export interface AuthUser {
  id: number;
  full_name: string;
  email: string;
  role: 'user' | 'admin';
  target_exams: string | null;
  email_alerts_enabled: boolean;
  is_active: boolean;
  created_at: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function createAccessToken(user: { id: number; email: string; role: string }): string {
  return jwt.sign({ sub: String(user.id), email: user.email, role: user.role }, JWT_SECRET, {
    expiresIn: '12h',
  });
}

export function mapUserRow(row: Record<string, unknown>): AuthUser {
  return {
    id: Number(row.id),
    full_name: String(row.full_name),
    email: String(row.email),
    role: row.role === 'admin' ? 'admin' : 'user',
    target_exams: row.target_exams ? String(row.target_exams) : null,
    email_alerts_enabled: Boolean(row.email_alerts_enabled),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
  };
}

function resolveUserFromHeader(req: Request): AuthUser | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string };
    const userId = Number(decoded.sub);
    if (!userId) return null;
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
    if (!row || !row.is_active) return null;
    return mapUserRow(row);
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = resolveUserFromHeader(req);
  if (!user) {
    res.status(401).json({ detail: 'Authentication required' });
    return;
  }
  req.user = user;
  next();
}

export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  req.user = resolveUserFromHeader(req) || undefined;
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = resolveUserFromHeader(req);
  if (!user) {
    res.status(401).json({ detail: 'Authentication required' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ detail: 'Admin role required' });
    return;
  }
  req.user = user;
  next();
}
