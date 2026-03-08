/**
 * Browserbase cloud browser integration.
 *
 * Browserbase provides managed, scalable headless browser sessions with
 * built-in stealth mode, session recording, and bot-detection evasion.
 *
 * How it works:
 *  1. We call the Browserbase REST API to create a session.
 *  2. They return a CDP (Chrome DevTools Protocol) WebSocket URL.
 *  3. We pass that URL to `agent-browser connect <cdp-url>` which attaches
 *     the local agent-browser daemon to the remote session.
 *  4. All subsequent agent-browser commands run against the remote browser —
 *     the rest of Slapify's task runner is completely unaware of the difference.
 *
 * Docs: https://docs.browserbase.com/reference/api/create-a-session
 */

const BROWSERBASE_API = "https://www.browserbase.com/v1";

export interface BrowserbaseSession {
    id: string;
    cdpUrl: string;
    debuggerFullscreenUrl: string;
}

/**
 * Create a new Browserbase session and return its CDP URL.
 */
export async function createBrowserbaseSession(
    apiKey: string,
    projectId?: string
): Promise<BrowserbaseSession> {
    const body: Record<string, unknown> = {};
    if (projectId) body.projectId = projectId;

    const res = await fetch(`${BROWSERBASE_API}/sessions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-BB-API-Key": apiKey,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `Browserbase session creation failed (${res.status}): ${text}`
        );
    }

    const data = await res.json() as {
        id: string;
        connectUrl?: string;
        debuggerFullscreenUrl?: string;
    };

    // Browserbase returns connectUrl as the CDP WebSocket endpoint
    const cdpUrl = data.connectUrl || `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${data.id}`;

    return {
        id: data.id,
        cdpUrl,
        debuggerFullscreenUrl: data.debuggerFullscreenUrl || "",
    };
}
