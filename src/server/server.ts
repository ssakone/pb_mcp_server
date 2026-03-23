import { FastMCP } from "fastmcp";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerResources } from "../core/resources.js";
import { registerTools } from "../core/tools.js";
import { registerPrompts } from "../core/prompts.js";
import { authenticateAdmin } from "../core/services/pocketbase/index.js";

const STARTUP_DEBUG_LOG_PATH = join(process.cwd(), "logs", "startup-debug.log");

function writeStartupLog(
  message: string,
  meta?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const payload = meta ? ` | ${JSON.stringify(meta)}` : "";
  const line = `[${timestamp}] ${message}${payload}\n`;

  try {
    const dir = dirname(STARTUP_DEBUG_LOG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(STARTUP_DEBUG_LOG_PATH, line, { encoding: "utf8" });
  } catch (error) {
    const err =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error(`[startup-log-fallback] ${message} | ${err}`);
  }

  // Keep stderr logs too, for immediate visibility.
  console.error(message, meta ?? "");
}

function logEnvDiagnostics(): void {
  const email = process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.POCKETBASE_ADMIN_PASSWORD;
  const token = process.env.POCKETBASE_ADMIN_TOKEN;
  const baseUrl = process.env.POCKETBASE_URL ?? "http://127.0.0.1:8090";

  writeStartupLog("Startup environment diagnostics", {
    hasAdminEmail: Boolean(email),
    adminEmailPreview: email ? `${email.slice(0, 3)}***` : null,
    hasAdminPassword: Boolean(password),
    adminPasswordLength: password ? password.length : 0,
    hasAdminToken: Boolean(token),
    adminTokenLength: token ? token.length : 0,
    pocketbaseUrl: baseUrl,
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV ?? null,
    pid: process.pid,
  });
}

/**
 * Auto-authenticate with PocketBase if admin credentials are provided in env.
 *
 * Supported env vars:
 * - `POCKETBASE_ADMIN_EMAIL`
 * - `POCKETBASE_ADMIN_PASSWORD`
 * - `POCKETBASE_URL` (optional)
 * - `POCKETBASE_ADMIN_TOKEN` (optional; takes precedence if already set)
 */
async function autoAuthenticateAdmin(): Promise<void> {
  const token = process.env.POCKETBASE_ADMIN_TOKEN;
  const email = process.env.POCKETBASE_ADMIN_EMAIL;
  const password = process.env.POCKETBASE_ADMIN_PASSWORD;
  const baseUrl = process.env.POCKETBASE_URL;

  writeStartupLog("Auto-auth check started", {
    hasToken: Boolean(token),
    hasEmail: Boolean(email),
    hasPassword: Boolean(password),
    baseUrl: baseUrl ?? "http://127.0.0.1:8090",
  });

  // If a token is already present, keep using it.
  if (token) {
    writeStartupLog(
      "Auto-auth skipped because POCKETBASE_ADMIN_TOKEN is already set",
      { tokenLength: token.length },
    );
    return;
  }

  // Need both credentials to authenticate.
  if (!email || !password) {
    writeStartupLog(
      "Auto-auth skipped: missing POCKETBASE_ADMIN_EMAIL or POCKETBASE_ADMIN_PASSWORD",
      {
        hasEmail: Boolean(email),
        hasPassword: Boolean(password),
      },
    );
    return;
  }

  try {
    writeStartupLog("Attempting PocketBase admin auto-authentication", {
      emailPreview: `${email.slice(0, 3)}***`,
      baseUrl: baseUrl ?? "http://127.0.0.1:8090",
    });

    const result = await authenticateAdmin({ email, password }, baseUrl);

    // Persist token in env for the lifetime of this process.
    process.env.POCKETBASE_ADMIN_TOKEN = result.token;

    writeStartupLog("Auto-authentication successful", {
      userId: result.user.id,
      isAdmin: result.user.isAdmin,
      tokenLength: result.token.length,
    });
  } catch (error) {
    const err = error as { code?: string; status?: number; details?: unknown };
    const message = error instanceof Error ? error.message : String(error);

    writeStartupLog("Auto-authentication failed", {
      message,
      code: err?.code ?? null,
      status: err?.status ?? null,
      details: err?.details ?? null,
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });

    writeStartupLog(
      "Admin tools may fail until auth succeeds or a valid token is provided",
    );
  }
}

// Create and start the MCP server
async function startServer() {
  try {
    writeStartupLog("Server startup initiated");
    logEnvDiagnostics();

    // Auto-authenticate before registering tools/resources.
    await autoAuthenticateAdmin();

    const server = new FastMCP({
      name: "MCP Server",
      version: "1.0.0",
    });

    registerResources(server);
    registerTools(server);
    registerPrompts(server);

    writeStartupLog("MCP Server initialized");
    writeStartupLog("Server is ready to handle requests");

    return server;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStartupLog("Failed to initialize server", {
      message,
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    process.exit(1);
  }
}

export default startServer;
