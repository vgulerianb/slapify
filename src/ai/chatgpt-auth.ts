/**
 * Sign in with ChatGPT, so the `codex` provider runs on a ChatGPT plan
 * (Plus/Pro/Business) instead of pay-per-token API credits.
 *
 * Ported from vercel-labs/fx (Apache-2.0, src/core/auth/chatgpt_oauth.zig and
 * sdk/chatgpt.js). Like fx, slapify does its own browser sign-in against
 * OpenAI's auth server using the Codex CLI's public OAuth client, then keeps
 * the tokens itself. It does not read or touch ~/.codex.
 *
 *   slapify login codex   → PKCE sign-in in the browser, callback on localhost
 *   tokens                → ~/.slapify/chatgpt-auth.json (0600)
 *   every request         → refreshed shortly before expiry, rotated refresh
 *                           tokens saved, the account id must not change
 *
 * The Codex endpoint this feeds is undocumented and may change without
 * notice; OpenAI's terms apply to how a plan is used.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** The redirect URIs registered for the client. fx falls back to the second. */
const CALLBACK_PORTS = [1455, 1457];
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Sent as `originator` on sign-in and on every Codex request. */
export const ORIGINATOR = process.env.SLAPIFY_CODEX_ORIGINATOR || "slapify";

export interface ChatGPTAuth {
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  expires_at: number;
  account_id: string;
  email?: string;
}

/** Where the tokens live. Overridable for tests. */
export function authFilePath(): string {
  return (
    process.env.SLAPIFY_CHATGPT_AUTH_FILE ||
    path.join(os.homedir(), ".slapify", "chatgpt-auth.json")
  );
}

/**
 * The auth server, or a loopback test server from the environment. Anything
 * else is refused, so an environment variable can never send tokens to a
 * third party (same rule as fx's e2e overrides).
 */
function issuer(): string {
  const override = process.env.SLAPIFY_CHATGPT_ISSUER;
  if (!override) return CHATGPT_ISSUER;
  if (!isLoopbackUrl(override)) {
    throw new Error("SLAPIFY_CHATGPT_ISSUER must be a loopback http URL");
  }
  return override.replace(/\/+$/, "");
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Claims of a JWT, without verifying it (the server already did). */
export function jwtClaims(token: string): Record<string, any> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function accountIdOf(...tokens: Array<string | undefined>): string {
  for (const t of tokens) {
    const id = t ? jwtClaims(t)?.[AUTH_CLAIM]?.chatgpt_account_id : undefined;
    if (typeof id === "string" && id) return id;
  }
  return "";
}

function emailOf(...tokens: Array<string | undefined>): string | undefined {
  for (const t of tokens) {
    if (!t) continue;
    const c = jwtClaims(t);
    const email = c?.[PROFILE_CLAIM]?.email || c?.email;
    if (typeof email === "string" && email) return email;
  }
  return undefined;
}

export function loadChatGPTAuth(): ChatGPTAuth | null {
  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
    if (!raw?.access_token || !raw?.refresh_token || !raw?.account_id) return null;
    return raw as ChatGPTAuth;
  } catch {
    return null;
  }
}

function saveChatGPTAuth(auth: ChatGPTAuth): void {
  const file = authFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write then rename, so a crash mid-write never leaves a torn token file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function logoutChatGPT(): boolean {
  try {
    fs.unlinkSync(authFilePath());
    return true;
  } catch {
    return false;
  }
}

function tokensToAuth(tokens: any, previous?: ChatGPTAuth): ChatGPTAuth {
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) {
    throw new Error("ChatGPT sign-in returned no access token");
  }
  const refresh = tokens.refresh_token || previous?.refresh_token;
  if (!refresh) throw new Error("ChatGPT sign-in returned no refresh token");
  const account = accountIdOf(tokens.access_token, tokens.id_token) || previous?.account_id || "";
  if (!account) throw new Error("ChatGPT token carries no account id — is this a ChatGPT plan account?");
  const fromClaims = Number(jwtClaims(tokens.access_token)?.exp) * 1000;
  const expiresAt = Number.isFinite(tokens.expires_in)
    ? Date.now() + Number(tokens.expires_in) * 1000
    : Number.isFinite(fromClaims) ? fromClaims : Date.now() + 60 * 60_000;
  return {
    access_token: tokens.access_token,
    refresh_token: refresh,
    expires_at: expiresAt,
    account_id: account,
    email: emailOf(tokens.id_token, tokens.access_token) || previous?.email,
  };
}

let refreshing: Promise<ChatGPTAuth> | null = null;

/**
 * Credentials good for at least a few more minutes, refreshing when needed.
 * Concurrent callers share one refresh, so a rotated refresh token is never
 * spent twice.
 */
export async function getChatGPTAuth(opts: { forceRefresh?: boolean } = {}): Promise<ChatGPTAuth> {
  const current = loadChatGPTAuth();
  if (!current) {
    throw new Error("Not signed in to ChatGPT (401). Run `slapify login codex` first.");
  }
  if (!opts.forceRefresh && current.expires_at - Date.now() > REFRESH_MARGIN_MS) return current;
  refreshing ??= refreshChatGPTAuth(current).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refreshChatGPTAuth(current: ChatGPTAuth): Promise<ChatGPTAuth> {
  const res = await fetch(`${issuer()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CHATGPT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `ChatGPT token refresh failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}. ` +
        "Run `slapify login codex` to sign in again."
    );
  }
  const next = tokensToAuth(await res.json(), current);
  // A refresh must never switch accounts under a running agent.
  if (next.account_id !== current.account_id) {
    throw new Error("ChatGPT token refresh returned a different account. Run `slapify login codex` again.");
  }
  saveChatGPTAuth(next);
  return next;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(redirectUri: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  });
  return `${issuer()}/oauth/authorize?${q.toString()}`;
}

function page(title: string, detail: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}` +
    `main{max-width:28rem;text-align:center}</style></head>` +
    `<body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`
  );
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      if (i >= CALLBACK_PORTS.length) {
        reject(new Error(`Ports ${CALLBACK_PORTS.join(" and ")} are busy; free one and try again.`));
        return;
      }
      server.once("error", (err: any) => {
        if (err?.code === "EADDRINUSE") tryPort(i + 1);
        else reject(err);
      });
      server.listen(CALLBACK_PORTS[i], "127.0.0.1", () => resolve(CALLBACK_PORTS[i]));
    };
    tryPort(0);
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The URL is printed too; opening the browser is a convenience.
  }
}

/**
 * Browser sign-in. Resolves once the tokens are saved.
 * `onUrl` gets the sign-in URL, to print in case the browser does not open.
 */
export async function loginWithChatGPT(
  opts: { onUrl?: (url: string) => void; openBrowser?: boolean } = {}
): Promise<ChatGPTAuth> {
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(24).toString("base64url");
  let finish!: (r: { code: string } | { error: string }) => void;
  const result = new Promise<{ code: string } | { error: string }>((r) => (finish = r));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://localhost");
    if (u.pathname !== "/auth/callback") {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const reply = (status: number, title: string, detail: string) =>
      res
        .writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        })
        .end(page(title, detail));
    if (u.searchParams.get("state") !== state) {
      reply(400, "Sign-in failed", "The sign-in response did not match this request. Run the login again.");
      return;
    }
    const error = u.searchParams.get("error");
    if (error) {
      reply(400, "Sign-in failed", "You can close this tab and try again.");
      finish({ error: `${error}: ${u.searchParams.get("error_description") || ""}`.trim() });
      return;
    }
    const code = u.searchParams.get("code");
    if (!code) {
      reply(400, "Sign-in failed", "No authorization code was returned.");
      return;
    }
    reply(200, "Signed in to slapify", "You can close this tab and go back to the terminal.");
    finish({ code });
  });

  const port = await listen(server);
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const url = authorizeUrl(redirectUri, challenge, state);
  opts.onUrl?.(url);
  if (opts.openBrowser !== false) openBrowser(url);

  const timer = setTimeout(() => finish({ error: "timed out waiting for the browser sign-in" }), LOGIN_TIMEOUT_MS);
  try {
    const r = await result;
    if ("error" in r) throw new Error(`ChatGPT sign-in failed: ${r.error}`);
    const res = await fetch(`${issuer()}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CHATGPT_CLIENT_ID,
        code: r.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`ChatGPT token exchange failed with HTTP ${res.status}: ${detail}`);
    }
    const auth = tokensToAuth(await res.json());
    saveChatGPTAuth(auth);
    return auth;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
