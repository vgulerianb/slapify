/**
 * Low-level input over the Chrome DevTools Protocol: real key-down/key-up
 * with a hold in between, and mouse events at viewport coordinates.
 *
 * agent-browser's `press` taps a key, which is right for forms and wrong for
 * anything that reads held keys: games (hold W to drive), canvas apps, drag
 * interactions, keyboard-driven players. Those need the key down for a
 * duration, several keys at once, and clicks at a position rather than on an
 * element ref, because a canvas has no elements. Events go through the
 * browser's own input pipeline, so they reach focused iframes (including
 * cross-origin ones) exactly as a person's keyboard would.
 */

import WebSocket from "ws";

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
};

/** Key name ("w", "Space", "ArrowUp", "F", "3") to its DevTools definition. */
export function keyDef(name: string): KeyDef {
  const raw = String(name).trim();
  const lower = raw.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];
  if (/^[a-z]$/i.test(raw)) {
    const c = lower;
    return { key: c, code: `Key${c.toUpperCase()}`, keyCode: c.toUpperCase().charCodeAt(0), text: c };
  }
  if (/^[0-9]$/.test(raw)) return { key: raw, code: `Digit${raw}`, keyCode: raw.charCodeAt(0), text: raw };
  const f = lower.match(/^f([1-9]|1[0-2])$/);
  if (f) return { key: raw.toUpperCase(), code: raw.toUpperCase(), keyCode: 111 + Number(f[1]) };
  throw new Error(`Unknown key "${name}". Use a letter, a digit, F1-F12, or one of: ${Object.keys(NAMED).join(", ")}.`);
}

const MODIFIER_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export class CdpInput {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId = "";

  /**
   * @param markActive sets `window.__slapifyActive = <token>` in the tab the
   *   browser layer is driving (via agent-browser eval) and returns the token.
   *   Matching tabs by URL is not enough: recording opens a second tab with
   *   the same URL, and input sent to the stale one goes nowhere visible.
   */
  constructor(private browserWsUrl: string, private markActive: () => Promise<string>) { }

  private marker = "";
  private targetId = "";
  private listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>();

  private on(method: string, fn: (params: any, sessionId?: string) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) || []), fn]);
  }

  private captureSession = "";
  private capturing = false;
  private captureLoop: Promise<void> | null = null;

  /**
   * Stream JPEG frames of the tab being driven, for recording video of the
   * SAME tab the agent is using (agent-browser's own recorder opens a second
   * tab with the page loaded again, which doubled a game and its ads, and
   * broke it outright in a headed browser).
   *
   * Frames are captured on a timer rather than with Page.startScreencast:
   * a screencast only sends a frame when the page repaints, so a still page
   * gives no frames, and each timed capture carries its own timestamp.
   */
  async startScreencast(onFrame: (jpeg: Buffer, timestampSec: number) => void, size = { width: 1280, height: 800 }, fps = 10): Promise<void> {
    await this.attach();
    await this.ensureActive();
    this.captureSession = this.sessionId;
    // In headless Chrome a leftover blank tab (the chrome://newtab page the
    // browser opens at launch) can hold the compositor, and capturing any
    // other tab then hangs forever. Probe once; if the capture stalls, close
    // blank tabs nobody is attached to, which is what fixes it.
    const probe = () => Promise.race([
      this.send("Page.captureScreenshot", { format: "jpeg", quality: 10 }, this.captureSession).then(() => true, () => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
    ]);
    if (!(await probe())) {
      const { targetInfos = [] } = await this.send("Target.getTargets", {}, false).catch(() => ({}));
      for (const t of targetInfos) {
        const blank = /^(chrome:\/\/newtab\/?|about:blank)$/.test(t.url);
        if (t.type === "page" && blank && !t.attached && t.targetId !== this.targetId) {
          await this.send("Target.closeTarget", { targetId: t.targetId }, false).catch(() => { });
        }
      }
    }
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, this.captureSession).catch(() => { });
    this.capturing = true;
    const interval = 1000 / fps;
    this.captureLoop = (async () => {
      while (this.capturing) {
        const t0 = Date.now();
        try {
          const r = await this.send(
            "Page.captureScreenshot",
            { format: "jpeg", quality: 70, clip: undefined, optimizeForSpeed: true },
            this.captureSession
          );
          if (this.capturing && r?.data) onFrame(Buffer.from(r.data, "base64"), Date.now() / 1000);
        } catch {
          // a navigation in progress, a closing tab: try again next tick
        }
        await new Promise((res) => setTimeout(res, Math.max(0, interval - (Date.now() - t0))));
      }
    })();
    void size;
  }

  async stopScreencast(): Promise<void> {
    this.capturing = false;
    await this.captureLoop?.catch(() => { });
    this.captureLoop = null;
    this.captureSession = "";
  }

  /**
   * Session that keyboard events go to: the frame that was last clicked.
   * Input sent to the page does NOT reach a cross-origin iframe (it runs in
   * its own process), so a click there switches keys to that frame too.
   */
  private focusSession = "";
  private frameSessions = new Map<string, string>();

  private async send(method: string, params: Record<string, unknown> = {}, session: boolean | string = true): Promise<any> {
    const ws = this.ws!;
    const id = ++this.seq;
    const sid = typeof session === "string" ? session : session ? this.sessionId : "";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 10_000);
    });
  }

  /** Connect and attach to the tab agent-browser is driving (matched by URL). */
  async attach(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionId) return;
    this.ws = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.browserWsUrl, { perMessageDeflate: false });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (typeof msg.method === "string") {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
        return;
      }
      if (typeof msg.id !== "number") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
    });
    this.ws.on("close", () => {
      this.sessionId = "";
      this.focusSession = "";
      this.frameSessions.clear();
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
    await this.selectActive();
  }

  /** Is the attached session still the tab being driven? Re-select if not. */
  private async ensureActive(): Promise<void> {
    if (this.sessionId && this.marker) {
      try {
        const r = await this.send("Runtime.evaluate", { expression: `window.__slapifyActive === ${JSON.stringify(this.marker)}`, returnByValue: true });
        if (r?.result?.value === true) return;
      } catch { }
    }
    await this.selectActive();
  }

  /** Attach to the page target that carries the active-tab marker. */
  private async selectActive(): Promise<void> {
    this.marker = await this.markActive();
    this.focusSession = "";
    this.frameSessions.clear();
    const { targetInfos } = await this.send("Target.getTargets", {}, false);
    const pages = (targetInfos as Array<{ targetId: string; type: string; url: string }>).filter((t) => t.type === "page");
    for (const t of pages) {
      let sid = "";
      try {
        ({ sessionId: sid } = await this.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }, false));
        const r = await this.send("Runtime.evaluate", { expression: `window.__slapifyActive === ${JSON.stringify(this.marker)}`, returnByValue: true }, sid);
        if (r?.result?.value === true) {
          this.sessionId = sid;
          this.targetId = t.targetId;
          return;
        }
      } catch { }
      if (sid) await this.send("Target.detachFromTarget", { sessionId: sid }, false).catch(() => { });
    }
    throw new Error("Could not find the active tab to send input to");
  }

  /**
   * Which session should receive a pointer event at (x, y), and the point in
   * that frame's own coordinates. Walks cross-origin iframes under the point
   * (nested ones too) and attaches to their DevTools targets.
   */
  private async route(x: number, y: number): Promise<{ session: string; x: number; y: number }> {
    let session = this.sessionId, lx = x, ly = y;
    for (let depth = 0; depth < 4; depth++) {
      const probe = `(()=>{const f=[...document.querySelectorAll("iframe,frame")].map(e=>{const r=e.getBoundingClientRect();return{src:e.src,x:r.left+e.clientLeft,y:r.top+e.clientTop,w:e.clientWidth,h:e.clientHeight}}).find(f=>${lx}>=f.x&&${ly}>=f.y&&${lx}<f.x+f.w&&${ly}<f.y+f.h);return JSON.stringify(f?{...f,origin:location.origin}:null)})()`;
      let hit: { src: string; x: number; y: number; origin: string } | null = null;
      try {
        const r = await this.send("Runtime.evaluate", { expression: probe, returnByValue: true }, session);
        hit = JSON.parse(r?.result?.value || "null");
      } catch {
        break;
      }
      if (!hit || !hit.src) break;
      let childOrigin = "";
      try {
        childOrigin = new URL(hit.src).origin;
      } catch {
        break;
      }
      if (childOrigin === hit.origin) break; // same-origin frames get page input already
      const child = await this.frameSession(hit.src);
      if (!child) break;
      session = child;
      lx = lx - hit.x;
      ly = ly - hit.y;
    }
    return { session, x: lx, y: ly };
  }

  private async frameSession(src: string): Promise<string | null> {
    const cached = this.frameSessions.get(src);
    if (cached) return cached;
    const { targetInfos } = await this.send("Target.getTargets", {}, false);
    const origin = new URL(src).origin;
    const frames = (targetInfos as Array<{ targetId: string; type: string; url: string }>).filter((t) => t.type === "iframe");
    const t = frames.find((f) => f.url === src) || frames.find((f) => f.url.startsWith(origin));
    if (!t) return null;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }, false);
    this.frameSessions.set(src, sessionId);
    return sessionId;
  }

  private modifiers = 0;

  // No nativeVirtualKeyCode: it is the platform's own key code (on macOS 87
  // is keypad 5), so a Windows-style value there turns W into Numpad5.
  async keyDown(name: string): Promise<void> {
    await this.attach();
    await this.ensureActive();
    const k = keyDef(name);
    if (MODIFIER_BIT[k.key]) this.modifiers |= MODIFIER_BIT[k.key];
    await this.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      modifiers: this.modifiers,
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    }, this.focusSession || true);
  }

  async keyUp(name: string): Promise<void> {
    await this.attach();
    const k = keyDef(name);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      modifiers: this.modifiers,
    }, this.focusSession || true);
    if (MODIFIER_BIT[k.key]) this.modifiers &= ~MODIFIER_BIT[k.key];
  }

  /** Hold several keys together for `ms`, then release them (in reverse). */
  async holdKeys(keys: string[], ms: number): Promise<void> {
    keys.forEach(keyDef); // validate all before pressing any
    const down: string[] = [];
    try {
      for (const k of keys) {
        await this.keyDown(k);
        down.push(k);
      }
      await new Promise((r) => setTimeout(r, Math.max(0, ms)));
    } finally {
      for (const k of down.reverse()) await this.keyUp(k).catch(() => { });
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.attach();
    await this.ensureActive();
    const t = await this.route(x, y);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: t.x, y: t.y, modifiers: this.modifiers }, t.session);
  }

  async click(x: number, y: number, button: "left" | "right" = "left", holdMs = 60): Promise<void> {
    await this.attach();
    await this.ensureActive();
    const t = await this.route(x, y);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: t.x, y: t.y }, t.session);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: t.x, y: t.y, button, clickCount: 1 }, t.session);
    await new Promise((r) => setTimeout(r, holdMs));
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: t.x, y: t.y, button, clickCount: 1 }, t.session);
    // Keys follow the click, like a person's focus does.
    this.focusSession = t.session === this.sessionId ? "" : t.session;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch { }
    this.ws = null;
    this.sessionId = "";
  }
}
