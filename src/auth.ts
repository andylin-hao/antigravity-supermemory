import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { PLUGIN_VERSION, resolveAuthDir, resolveMcpUrl, type Config } from "./config.js";
import { clearDedupeCaches } from "./dedupe.js";
import { openUrl } from "./open-url.js";
import { environmentFetch } from "./transport.js";

export const DEFAULT_AUTH_PORT = 19882;
export const AUTH_WAIT_MS = 5 * 60 * 1000;
export const HOOK_AUTH_WAIT_MS = 18000;
const POLL_MS = 250;
export const REFRESH_TIMEOUT_MS = 3000;
const REFRESH_REQUEST_TIMEOUT_MS = 10000;
export const REFRESH_SKEW_MS = 60000;
const OAUTH_SCOPE = "openid profile email offline_access";

export interface OAuthConfig {
  apiBaseUrl: string;
  issuer: string;
  resource: string;
}

export interface RegisteredClient extends OAuthConfig {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export interface OAuthCredentials extends RegisteredClient {
  type: "oauth";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  savedAt?: string;
}

export interface ApiKeyCredentials {
  type?: undefined;
  apiKey: string;
  savedAt?: string;
}

export type StoredCredentials = OAuthCredentials | ApiKeyCredentials;

export type AuthSource = "env" | "project" | "config" | "oauth" | "credentials";

export interface ResolvedAuth {
  token: string;
  source: AuthSource;
}

const PAGE_STYLE = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;background:#0b1015;color:#f4f4f5;text-align:center;padding:24px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:14px;margin-bottom:16px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
h1{font-size:30px;font-weight:500;margin-bottom:12px}
p{color:#a1a1aa;font-size:16px;max-width:460px;line-height:1.5}`;

const AUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connected - Supermemory</title><style>${PAGE_STYLE}</style></head><body>
<div class="badge"><span class="dot" style="background:#22c55e"></span><span style="color:#22c55e">Connected</span></div>
<h1>Supermemory is ready</h1>
<p>You can close this tab and return to Antigravity. Memory turns on from your next message.</p>
</body></html>`;

function renderAuthError(error: unknown): string {
  const denied = (error as { code?: string } | null)?.code === "access_denied";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${denied ? "Authorization Denied" : "Connection Failed"} - Supermemory</title><style>${PAGE_STYLE}</style></head><body>
<div class="badge"><span class="dot" style="background:#ef4444"></span><span style="color:#ef4444">Not connected</span></div>
<h1>${denied ? "Authorization Denied" : "Connection Failed"}</h1>
<p>${denied ? "You declined access, so Supermemory was not connected. Return to Antigravity and run /supermemory-login to retry." : "Supermemory could not finish signing you in. Return to Antigravity and run /supermemory-login to try again."}</p>
</body></html>`;
}

function files(authDir: string) {
  return {
    credentials: join(authDir, "credentials.json"),
    client: join(authDir, "oauth-client.json"),
    lock: join(authDir, "auth.lock"),
    loggedOut: join(authDir, "logged-out.json"),
  };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(authDir: string, path: string, data: unknown): void {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function loadCredentials(authDir: string): StoredCredentials | undefined {
  const data = readJson(files(authDir).credentials);
  if (!data) return undefined;
  if (data.type === "oauth" && typeof data.clientId === "string") return data as unknown as OAuthCredentials;
  if (typeof data.apiKey === "string" && data.apiKey.trim()) {
    return { apiKey: data.apiKey.trim(), savedAt: typeof data.savedAt === "string" ? data.savedAt : undefined };
  }
  return undefined;
}

export function saveCredentials(authDir: string, credentials: string | Record<string, unknown> | StoredCredentials): void {
  const payload = typeof credentials === "string" ? { apiKey: credentials } : credentials;
  writeJson(authDir, files(authDir).credentials, { ...payload, savedAt: new Date().toISOString() });
}

export function isLoggedOut(authDir: string): boolean {
  return existsSync(files(authDir).loggedOut);
}

export function secureUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("OAuth requires HTTPS (HTTP is allowed only for loopback development).");
  }
  return url.toString().replace(/\/+$/, "");
}

export function getOAuthConfig(baseUrl: string, mcpUrl?: string, issuerOverride?: string, env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const apiBaseUrl = secureUrl(baseUrl);
  const resource = secureUrl(mcpUrl ?? resolveMcpUrl(baseUrl, undefined, env));
  const issuer = secureUrl(issuerOverride ?? env.SUPERMEMORY_OAUTH_ISSUER ?? env.SUPERMEMORY_AUTH_URL ?? `${apiBaseUrl}/api/auth`);
  return { apiBaseUrl, issuer, resource };
}

function sameOAuthConfig(candidate: Partial<OAuthConfig> | undefined, target: OAuthConfig): boolean {
  return Boolean(candidate && candidate.apiBaseUrl === target.apiBaseUrl && candidate.issuer === target.issuer && candidate.resource === target.resource);
}

function issuerEndpoint(value: unknown, issuer: string): string {
  if (typeof value !== "string" || !value) throw new Error("OAuth metadata is missing a required endpoint.");
  const endpoint = secureUrl(value);
  if (new URL(endpoint).origin !== new URL(issuer).origin) {
    throw new Error("OAuth endpoint does not belong to the configured issuer.");
  }
  return endpoint;
}

function recoverAbandonedLock(lockPath: string): void {
  let recovery = "";
  let linked = false;
  try {
    const original = statSync(lockPath);
    recovery = `${lockPath}.${original.dev}.${original.ino}.recovery`;
    linkSync(lockPath, recovery);
    linked = true;
    const snapshot = statSync(recovery);
    if (snapshot.ino !== original.ino || snapshot.dev !== original.dev) return;
    const owner = readJson(recovery);
    let abandoned = false;
    if (typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        abandoned = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } else {
      abandoned = Date.now() - snapshot.mtimeMs > AUTH_WAIT_MS * 2;
    }
    if (abandoned) {
      const current = statSync(lockPath);
      if (current.ino === original.ino && current.dev === original.dev) unlinkSync(lockPath);
    }
  } catch (error) {
    if (!["ENOENT", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (linked && recovery) rmSync(recovery, { force: true });
  }
}

function stopBackgroundLogin(lockPath: string): void {
  const owner = readJson(lockPath);
  if (!owner?.background || typeof owner.pid !== "number" || owner.pid <= 0) return;
  try {
    process.kill(owner.pid);
  } catch { /* Already exited. */ }
}

async function withAuthLock<T>(
  authDir: string,
  action: (remainingMs: number) => Promise<T>,
  timeoutMs: number,
  options: { preempt?: boolean; background?: boolean } = {},
): Promise<T> {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const { lock } = files(authDir);
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  let stopped = false;
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (options.preempt && !stopped) {
        stopBackgroundLogin(lock);
        stopped = true;
      }
      recoverAbandonedLock(lock);
      if (Date.now() >= deadline) throw new Error("Supermemory authentication is busy. Try again.");
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ...(options.background ? { background: true } : {}) }));
    return await action(Math.max(1, deadline - Date.now()));
  } finally {
    try { closeSync(fd); } catch { /* Ignore close errors. */ }
    rmSync(lock, { force: true });
  }
}

async function oauthRequest(url: URL | string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await environmentFetch(url, {
    ...init,
    redirect: "error",
    headers: {
      "x-sm-source": "antigravity",
      "x-sm-plugin-version": PLUGIN_VERSION,
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  const data = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!response.ok) {
    const code = typeof data.error === "string" && ["invalid_grant", "invalid_client", "access_denied"].includes(data.error)
      ? data.error
      : "oauth_request_failed";
    throw Object.assign(new Error(`Supermemory authorization failed (${code}, HTTP ${response.status}).`), {
      code,
      status: response.status,
    });
  }
  return data;
}

async function registerClient(authDir: string, config: OAuthConfig, redirectUri: string, signal: AbortSignal): Promise<RegisteredClient> {
  const { client: clientFile } = files(authDir);
  const saved = readJson(clientFile) as Partial<RegisteredClient> | undefined;
  if (saved && sameOAuthConfig(saved, config) && typeof saved.clientId === "string" && saved.clientId && saved.redirectUri === redirectUri && typeof saved.authorizationEndpoint === "string" && typeof saved.tokenEndpoint === "string") {
    return saved as RegisteredClient;
  }
  const metadata = await oauthRequest(new URL("/.well-known/oauth-authorization-server", `${config.issuer}/`), { signal });
  if (secureUrl(String(metadata.issuer ?? "")) !== config.issuer) {
    throw new Error("OAuth discovery returned an unexpected issuer.");
  }
  const authorizationEndpoint = issuerEndpoint(metadata.authorization_endpoint, config.issuer);
  const tokenEndpoint = issuerEndpoint(metadata.token_endpoint, config.issuer);
  const registrationEndpoint = issuerEndpoint(metadata.registration_endpoint, config.issuer);
  const revocationEndpoint = metadata.revocation_endpoint ? issuerEndpoint(metadata.revocation_endpoint, config.issuer) : undefined;
  const registration = await oauthRequest(registrationEndpoint, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Supermemory for Antigravity",
      client_uri: "https://github.com/andylin-hao/antigravity-supermemory",
      software_id: "antigravity-supermemory",
      software_version: PLUGIN_VERSION,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
    }),
  });
  if (typeof registration.client_id !== "string" || !registration.client_id || registration.token_endpoint_auth_method !== "none") {
    throw new Error("OAuth registration did not return a public client.");
  }
  const registered: RegisteredClient = {
    ...config,
    clientId: registration.client_id,
    redirectUri,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
  };
  signal.throwIfAborted();
  writeJson(authDir, clientFile, registered);
  return registered;
}

async function exchangeToken(
  authDir: string,
  client: RegisteredClient,
  parameters: Record<string, string>,
  signal: AbortSignal,
  previous?: OAuthCredentials,
): Promise<string> {
  const data = await oauthRequest(issuerEndpoint(client.tokenEndpoint, client.issuer), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      resource: client.resource,
      ...parameters,
    }),
  });
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : previous?.refreshToken;
  if (
    typeof data.access_token !== "string" || !data.access_token
    || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
    || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0
    || typeof refreshToken !== "string" || !refreshToken
  ) {
    throw new Error("OAuth returned an invalid token response.");
  }
  signal.throwIfAborted();
  saveCredentials(authDir, {
    ...client,
    type: "oauth",
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  rmSync(files(authDir).loggedOut, { force: true });
  return data.access_token;
}

function authRequired(): Error {
  return Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" });
}

let pendingRefresh: Promise<string> | null = null;

export function refreshCredentials(authDir: string, config: OAuthConfig): Promise<string> {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = withAuthLock(authDir, async (remaining) => {
    const current = loadCredentials(authDir);
    if (!current || current.type !== "oauth" || !sameOAuthConfig(current, config)) throw authRequired();
    if (current.accessToken && (current.expiresAt ?? 0) > Date.now() + REFRESH_SKEW_MS) return current.accessToken;
    if (!current.refreshToken) throw authRequired();
    try {
      return await exchangeToken(authDir, current, {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }, AbortSignal.timeout(remaining), current);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "invalid_grant" || code === "invalid_client") {
        const stripped: OAuthCredentials = { ...current };
        delete stripped.accessToken;
        delete stripped.refreshToken;
        delete stripped.expiresAt;
        saveCredentials(authDir, stripped);
        if (code === "invalid_client") rmSync(files(authDir).client, { force: true });
        throw authRequired();
      }
      throw error;
    }
  }, REFRESH_REQUEST_TIMEOUT_MS).finally(() => {
    pendingRefresh = null;
  });
  pendingRefresh.catch(() => {});
  return pendingRefresh;
}

export async function settleAuth(): Promise<void> {
  while (pendingRefresh) {
    await pendingRefresh.catch(() => {});
  }
}

export async function getAccessToken(authDir: string, config: OAuthConfig, timeoutMs = REFRESH_TIMEOUT_MS): Promise<string> {
  const saved = loadCredentials(authDir);
  if (!saved || saved.type !== "oauth" || !sameOAuthConfig(saved, config)) throw authRequired();
  if (saved.accessToken && (saved.expiresAt ?? 0) > Date.now() + REFRESH_SKEW_MS) return saved.accessToken;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("Supermemory token refresh is still in progress."), {
        code: "AUTH_PENDING",
        name: "TimeoutError",
      }));
    }, timeoutMs);
  });
  return Promise.race([refreshCredentials(authDir, config), expired]).finally(() => clearTimeout(timer));
}

export async function clearCredentials(authDir: string, stateDir?: string): Promise<void> {
  await withAuthLock(authDir, async (remaining) => {
    const current = loadCredentials(authDir);
    if (current?.type === "oauth" && current.refreshToken && current.revocationEndpoint) {
      try {
        await oauthRequest(issuerEndpoint(current.revocationEndpoint, current.issuer), {
          method: "POST",
          signal: AbortSignal.timeout(remaining),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: current.clientId,
            token: current.refreshToken,
            token_type_hint: "refresh_token",
          }),
        });
      } catch { /* Proceed with local logout even if revocation fails. */ }
    }
    writeJson(authDir, files(authDir).loggedOut, { loggedOutAt: new Date().toISOString() });
    rmSync(files(authDir).credentials, { force: true });
    if (stateDir) await clearDedupeCaches(stateDir);
  }, REFRESH_REQUEST_TIMEOUT_MS, { preempt: true });
}

export interface AuthFlowOptions {
  env?: NodeJS.ProcessEnv;
  port?: number;
  timeoutMs?: number;
  force?: boolean;
  background?: boolean;
  printUrl?: boolean;
  noBrowser?: boolean;
  onAuthorizeUrl?: (url: string) => void;
}

export async function startAuthFlow(authDir: string, config: OAuthConfig, options: AuthFlowOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const requestedPort = options.port ?? (env.SUPERMEMORY_AUTH_PORT !== undefined ? Number(env.SUPERMEMORY_AUTH_PORT) : DEFAULT_AUTH_PORT);
  const timeoutMs = options.timeoutMs ?? (env.SUPERMEMORY_AUTH_TIMEOUT ? Number(env.SUPERMEMORY_AUTH_TIMEOUT) : AUTH_WAIT_MS);
  return withAuthLock(authDir, async (remaining) => {
    const current = loadCredentials(authDir);
    if (!options.force && current?.type === "oauth" && sameOAuthConfig(current, config) && current.accessToken && (current.expiresAt ?? 0) > Date.now() + REFRESH_SKEW_MS) {
      return current.accessToken;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("AUTH_TIMEOUT")), remaining);
    let server: ReturnType<typeof createServer> | undefined;
    try {
      server = createServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.once("error", () => rejectListen(new Error("Cannot open the authentication callback port. Retry after other logins finish.")));
        server!.listen(requestedPort, "127.0.0.1", () => resolveListen());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing callback port");
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const client = await registerClient(authDir, config, redirectUri, controller.signal);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorizationUrl = new URL(issuerEndpoint(client.authorizationEndpoint, client.issuer));
      authorizationUrl.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPE,
        resource: client.resource,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
        prompt: "consent",
      }).toString();
      return await new Promise<string>((resolveToken, rejectToken) => {
        let exchanging = false;
        controller.signal.addEventListener("abort", () => rejectToken(controller.signal.reason), { once: true });
        server!.on("request", (req, res) => {
          void (async () => {
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Referrer-Policy", "no-referrer");
            let url: URL;
            try {
              url = new URL(req.url ?? "/", redirectUri);
            } catch {
              res.writeHead(400).end();
              return;
            }
            if (req.method !== "GET" || url.pathname !== "/callback") {
              res.writeHead(404).end();
              return;
            }
            const receivedState = Buffer.from(url.searchParams.get("state") ?? "");
            const expectedState = Buffer.from(state);
            if (
              receivedState.length !== expectedState.length
              || !timingSafeEqual(receivedState, expectedState)
              || (url.searchParams.has("iss") && url.searchParams.get("iss") !== client.issuer)
            ) {
              res.writeHead(400).end("Invalid authorization state.");
              return;
            }
            if (exchanging) {
              res.writeHead(409).end();
              return;
            }
            exchanging = true;
            try {
              if (url.searchParams.has("error")) {
                throw Object.assign(new Error("Authorization was denied."), { code: "access_denied" });
              }
              const code = url.searchParams.get("code");
              if (!code) throw new Error("Authorization code missing.");
              const token = await exchangeToken(authDir, client, {
                grant_type: "authorization_code",
                code,
                code_verifier: verifier,
                redirect_uri: redirectUri,
              }, controller.signal);
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(AUTH_SUCCESS_HTML, () => resolveToken(token));
            } catch (error) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(renderAuthError(error));
              if ((error as { code?: string } | null)?.code === "invalid_client" && !controller.signal.aborted) {
                rmSync(files(authDir).client, { force: true });
              }
              rejectToken(error);
            }
          })();
        });
        const href = authorizationUrl.toString();
        options.onAuthorizeUrl?.(href);
        if (options.printUrl) {
          process.stdout.write(`SUPERMEMORY_AUTHORIZE_URL=${href}\n`);
          return;
        }
        if (!options.background) {
          console.log(`If the browser doesn't open, visit: ${href}`);
        }
        if (options.noBrowser || env.SUPERMEMORY_NO_BROWSER === "true") return;
        openUrl(authorizationUrl, env).catch(() => {
          if (!options.background) {
            console.log("Could not open a browser. Open the URL above to finish signing in.");
          }
        });
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      server?.close();
      server?.closeAllConnections();
    }
  }, timeoutMs, { background: options.background, preempt: true });
}

export function startBackgroundAuth(
  authDir: string,
  config: OAuthConfig,
  cliEntryArgs: string[],
  waitMs = HOOK_AUTH_WAIT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const child = spawn(
    process.execPath,
    [...cliEntryArgs, "auth-server", config.apiBaseUrl, config.resource, config.issuer],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env, SUPERMEMORY_AUTH_DIR: authDir },
    },
  );
  child.unref();
  return new Promise<string>((resolveToken, rejectToken) => {
    const startedAt = Date.now();
    const done = (error: Error | undefined, token?: string) => {
      clearInterval(timer);
      child.removeAllListeners();
      if (error) rejectToken(error);
      else resolveToken(token!);
    };
    child.on("error", () => done(new Error("AUTH_FAILED")));
    child.on("exit", (code, signal) => {
      if (code !== 0 && !signal) done(new Error("AUTH_FAILED"));
    });
    const timer = setInterval(() => {
      const current = loadCredentials(authDir);
      if (current?.type === "oauth" && sameOAuthConfig(current, config) && current.accessToken && (current.expiresAt ?? 0) > Date.now() + REFRESH_SKEW_MS) {
        done(undefined, current.accessToken);
      } else if (Date.now() - startedAt > waitMs) {
        done(new Error("AUTH_PENDING"));
      }
    }, POLL_MS);
  });
}

export async function resolveAuth(
  config: Config,
  options: { env?: NodeJS.ProcessEnv; projectApiKey?: string; timeoutMs?: number } = {},
): Promise<ResolvedAuth | undefined> {
  if (options.env) {
    const envKey = options.env.SUPERMEMORY_ANTIGRAVITY_API_KEY || options.env.SUPERMEMORY_API_KEY;
    if (envKey) return { token: envKey, source: "env" };
  }
  if (options.projectApiKey) return { token: options.projectApiKey, source: "project" };
  if (config.apiKey) return { token: config.apiKey, source: "config" };
  const authDir = config.authDir ?? (options.env ? resolveAuthDir(config, options.env) : undefined);
  if (!authDir) return undefined;
  const stored = loadCredentials(authDir);
  if (!stored) return undefined;
  if (stored.type === "oauth") {
    const oauthConfig = getOAuthConfig(config.baseUrl, config.mcpUrl, config.oauthIssuer, options.env ?? process.env);
    try {
      const token = await getAccessToken(authDir, oauthConfig, options.timeoutMs ?? REFRESH_TIMEOUT_MS);
      return { token, source: "oauth" };
    } catch {
      return undefined;
    }
  }
  return { token: stored.apiKey, source: "credentials" };
}

export function resolveConfiguredIdentity(config: Config, env?: NodeJS.ProcessEnv): { key?: string; loggedOut: boolean } {
  if (env) {
    const envKey = env.SUPERMEMORY_ANTIGRAVITY_API_KEY || env.SUPERMEMORY_API_KEY;
    if (envKey) return { key: envKey, loggedOut: false };
  }
  if (config.apiKey) return { key: config.apiKey, loggedOut: false };
  const authDir = config.authDir ?? (env ? resolveAuthDir(config, env) : undefined);
  if (!authDir) return { loggedOut: false };
  const stored = loadCredentials(authDir);
  if (stored) {
    const key = stored.type === "oauth" ? (stored.accessToken ?? stored.refreshToken ?? stored.clientId) : stored.apiKey;
    return { key, loggedOut: false };
  }
  return { loggedOut: isLoggedOut(authDir) };
}

export interface SessionAccount {
  email?: string;
  name?: string;
  organization?: string;
}

export async function fetchSessionAccount(baseUrl: string, token: string, timeoutMs = 8000): Promise<SessionAccount | undefined> {
  for (const route of ["/session", "/v3/session"]) {
    try {
      const response = await environmentFetch(`${baseUrl.replace(/\/+$/, "")}${route}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-sm-source": "antigravity",
          "x-sm-plugin-version": PLUGIN_VERSION,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const data = await response.json() as { user?: { email?: string; name?: string }; org?: { name?: string } } | null;
      if (data && typeof data === "object") {
        return {
          email: data.user?.email,
          name: data.user?.name,
          organization: data.org?.name,
        };
      }
    } catch { /* Optional account enrichment. */ }
  }
  return undefined;
}
