import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { isLongRunMode, runModeFromEnv } from "../config/env";

function boolEnv(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function configuredApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALAYA_API_KEY?.trim() ?? "";
}

export function isApiAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = boolEnv(env.ALAYA_REQUIRE_API_AUTH);
  const mode = runModeFromEnv(env);
  if (isLongRunMode(mode)) return true;
  if (explicit !== undefined) return explicit;
  return configuredApiKey(env).length > 0;
}

function bearerToken(req: Request): string {
  const header = req.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return req.get("x-alaya-api-key")?.trim() ?? "";
}

export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!isApiAuthRequired()) return next();

  const expected = configuredApiKey();
  if (!expected) {
    return res.status(503).json({ message: "api authentication is not configured" });
  }

  const provided = bearerToken(req);
  if (!provided || !constantTimeEqual(provided, expected)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ message: "unauthorized" });
  }

  return next();
}

type IpKind = "ipv4" | "ipv6";

function normalizeIp(value: string | undefined): string {
  if (!value) return "";
  const clean = value.trim().split(",")[0]?.trim() ?? "";
  if (clean.startsWith("::ffff:")) return clean.slice("::ffff:".length);
  return clean;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function ipKind(ip: string): IpKind | undefined {
  if (ipv4ToInt(ip) !== undefined) return "ipv4";
  if (ip.includes(":")) return "ipv6";
  return undefined;
}

function cidrAllows(cidr: string, ip: string): boolean {
  const [base, prefixRaw] = cidr.split("/");
  if (!base || prefixRaw == null) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix)) return false;
  const kind = ipKind(base);
  if (!kind || kind !== ipKind(ip)) return false;
  if (kind === "ipv6") {
    return prefix === 128 && base.toLowerCase() === ip.toLowerCase();
  }
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === undefined || ipInt === undefined || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

function metricsAllowedIps(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["127.0.0.1", "::1", ...(env.ALAYA_METRICS_ALLOWED_CIDRS ?? "").split(",")]
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isMetricsRequestAllowed(ip: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  for (const allowed of metricsAllowedIps(env)) {
    if (allowed.includes("/")) {
      if (cidrAllows(allowed, normalized)) return true;
    } else if (normalizeIp(allowed).toLowerCase() === normalized.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function requestIp(req: Request): string {
  if (boolEnv(process.env.ALAYA_TRUST_PROXY) === true) {
    const forwarded = normalizeIp(req.get("x-forwarded-for"));
    if (forwarded) return forwarded;
  }
  return normalizeIp(req.socket.remoteAddress ?? req.ip);
}

export function metricsAccessMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isMetricsRequestAllowed(requestIp(req))) return next();
  return res.status(403).type("text/plain").send("metrics forbidden\n");
}

export function validateApiAuthConfiguration(env: NodeJS.ProcessEnv = process.env): string[] {
  const mode = runModeFromEnv(env);
  if (!isLongRunMode(mode)) return [];
  if (!env.ALAYA_API_KEY?.trim()) return ["ALAYA_API_KEY is required in shadow/staging/production"];
  return [];
}
