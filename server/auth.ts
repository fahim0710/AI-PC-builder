import type { NextFunction, Request, Response } from "express";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { pool } from "./db/pool.js";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const firebaseApp = getApps()[0] ?? initializeApp({
  ...(serviceAccountJson ? { credential: cert(JSON.parse(serviceAccountJson)) } : {}),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

export type AuthenticatedRequest = Request & { authUser?: { uid: string } };

export async function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) return response.status(401).json({ error: "Authentication required" });

  try {
    const decoded = await getAuth(firebaseApp).verifyIdToken(token);
    const email = decoded.email?.trim().toLowerCase() ?? null;
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, email_verified, role, last_login_at)
       VALUES ($1, $2, $3, $4,
         CASE WHEN EXISTS (SELECT 1 FROM admin_emails WHERE email = $2) THEN 'admin' ELSE 'customer' END,
         NOW())
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         email_verified = EXCLUDED.email_verified,
         role = CASE
           WHEN EXISTS (SELECT 1 FROM admin_emails WHERE email = EXCLUDED.email) THEN 'admin'
           ELSE users.role
         END,
         last_login_at = NOW(), updated_at = NOW()`,
      [decoded.uid, email, decoded.name ?? null, decoded.email_verified ?? false],
    );
    request.authUser = { uid: decoded.uid };
    return next();
  } catch (error) {
    console.error("Firebase token verification failed", error);
    return response.status(401).json({ error: "Invalid or expired authentication token" });
  }
}

export async function requireAdmin(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  const result = await pool.query<{ role: string }>("SELECT role FROM users WHERE firebase_uid = $1", [request.authUser?.uid]);
  if (result.rows[0]?.role !== "admin") return response.status(403).json({ error: "Administrator access required" });
  return next();
}
