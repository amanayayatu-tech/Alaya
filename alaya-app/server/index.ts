import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { assertEnvValid } from "./config/env";
import { checkCapability, CapabilityDeniedError } from "./security/capabilities";
import { redactError, redactSensitiveData, redactSensitiveText } from "./security/redact";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { startCycleScheduler } from "./scheduler";

const envConfig = assertEnvValid();

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    source,
    message: redactSensitiveText(message),
  }));
}

function summarizeJsonForLog(value: unknown, maxLength = 1_200) {
  let text = "";
  try {
    text = JSON.stringify(redactSensitiveData(value));
  } catch {
    text = "[unserializable response]";
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${summarizeJsonForLog(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof CapabilityDeniedError) {
      return res.status(403).json({ message: err.message, capability: err.decision.capability, mode: err.decision.mode });
    }
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", source: "express", error: redactError(err) }));

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Serve both the API and client on PORT. reusePort is opt-in because some
  // local macOS/Node combinations return ENOTSUP when it is enabled.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "0.0.0.0";
  const listenOptions =
    process.env.REUSE_PORT === "true"
      ? { port, host, reusePort: true }
      : { port, host };

  httpServer.listen(listenOptions, () => {
    log(`serving on ${host}:${port} mode=${envConfig.mode}`);
  });

  // Auto-seed the demo project after the server is reachable. In live E2E the
  // seed is disabled so real LLM validation does not block readiness. Keep the
  // scheduler off until seeding finishes so it cannot consume half-seeded demo
  // cycles.
  if (process.env.ALAYA_AUTO_SEED_DEMO !== "false") {
    try {
      const { seedDemo, demoExists } = await import("./seed");
      if (!demoExists()) {
        await seedDemo();
        log("seeded demo project (3 flywheel cycles)");
      }
    } catch (e) {
      console.error("demo seed failed", e);
    }
  }

  if (process.env.ALAYA_SCHEDULER !== "false") {
    const decision = checkCapability({
      actor: "scheduler",
      capability: "scheduler_loop",
      target: "startCycleScheduler",
      payload: { intervalMs: process.env.ALAYA_SCHEDULER_INTERVAL_MS ?? 60_000 },
    });
    if (decision.allowed) {
      const scheduler = startCycleScheduler();
      scheduler.unref?.();
      log(`cycle scheduler enabled (${process.env.ALAYA_SCHEDULER_INTERVAL_MS ?? 60_000}ms)`, "scheduler");
    } else {
      log(`cycle scheduler not started: ${decision.reason}`, "scheduler");
    }
  }
})();
