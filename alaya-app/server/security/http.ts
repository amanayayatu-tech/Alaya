import type { NextFunction, Request, Response } from "express";
import { isProductionLikeMode, runModeFromEnv } from "../config/env";

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

function allowedCorsOrigins(): string[] {
  return parseList(process.env.ALAYA_CORS_ORIGINS);
}

function isOriginAllowed(origin: string): boolean {
  const configured = allowedCorsOrigins();
  if (configured.includes(origin)) return true;
  if (!isProductionLikeMode(runModeFromEnv()) && isLocalDevOrigin(origin)) return true;
  return false;
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  const productionLike = isProductionLikeMode(runModeFromEnv());
  const scriptSrc = productionLike ? "'self'" : "'self' 'unsafe-inline' 'unsafe-eval'";
  const connectSrc = productionLike ? "'self'" : "'self' ws: wss: http://localhost:* http://127.0.0.1:*";
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ${connectSrc}`,
  );
  if (productionLike) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (origin) {
    if (!isOriginAllowed(origin)) {
      return res.status(403).json({ message: "origin not allowed" });
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Alaya-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
  bucket: string;
}

const rateBuckets = new Map<string, { resetAt: number; count: number }>();

function clientKey(req: Request, bucket: string): string {
  return `${bucket}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = clientKey(req, options.bucket);
    const current = rateBuckets.get(key);
    const state = current && current.resetAt > now ? current : { resetAt: now + options.windowMs, count: 0 };
    state.count += 1;
    rateBuckets.set(key, state);
    const remaining = Math.max(0, options.max - state.count);
    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((state.resetAt - now) / 1000)));
    if (state.count > options.max) {
      return res.status(429).json({ message: "rate limit exceeded" });
    }
    return next();
  };
}

function positiveIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.trunc(parsed));
}

export function costEndpointRateLimit(bucket: string) {
  const windowMs = positiveIntEnv("ALAYA_COST_RATE_LIMIT_WINDOW_MS", 60_000, 1000);
  const max = positiveIntEnv("ALAYA_COST_RATE_LIMIT_MAX", 10, 1);
  return createRateLimitMiddleware({ windowMs, max, bucket });
}
