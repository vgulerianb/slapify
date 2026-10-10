// Anti-bot-detection init script, injected via `agent-browser --init-script`
// before any page script runs (in every frame, including dynamically created
// and srcdoc iframes — verified, so no per-iframe patching is needed).
//
// Guiding rule: only lie when the truth is actually an automation tell.
//
// Every patch is a detectable artifact in its own right, and a patch applied
// on the main thread can't be applied inside a Web Worker (init scripts don't
// run there) — so spoofing a value that was already realistic just creates a
// main-thread-vs-worker mismatch, which is a *stronger* signal than the value
// it replaced. Modern headless Chrome already reports real PDF plugins, a real
// locale and real GPU strings, so each patch below is gated on the underlying
// value actually looking automated. On a current Chrome this usually means
// only `navigator.webdriver` is touched.
//
// Second rule: never throw. A failed patch must not break the page.
(() => {
  const safe = (fn) => {
    try {
      fn();
    } catch {
      // Never let a patch failure break the page.
    }
  };

  // ── Make patched functions still look native ───────────────────────────────
  // Detectors call .toString() on suspicious functions/getters and look for
  // "[native code]". Anything we replace gets registered here.
  //
  // This override is installed LAST, and only if something above actually got
  // patched (see the end of this file). Overriding Function.prototype.toString
  // is itself detectable — a call through it leaves a different stack frame
  // than a genuine native call, which fingerprinters match against patterns
  // like /at Function\.toString/ — so it must never be installed just in case.
  // On a current Chrome nothing below needs patching and this stays untouched.
  const nativeNames = new WeakMap();
  const nativeToString = Function.prototype.toString;
  let patchCount = 0;
  const asNative = (fn, name) => {
    nativeNames.set(fn, name || fn.name || "");
    patchCount++;
    return fn;
  };

  /** defineProperty with a getter that reports itself as native. */
  const defineNativeGetter = (target, prop, value) => {
    const get = asNative(() => value, `get ${prop}`);
    Object.defineProperty(target, prop, { get, configurable: true });
  };

  // ── navigator.webdriver ────────────────────────────────────────────────────
  // Usually nothing to do: the `--disable-blink-features=AutomationControlled`
  // launch flag that stealth mode passes makes Chromium report `false` here
  // natively, with a real native getter and no JS seam. This is only a
  // fallback for a browser where that flag didn't take effect.
  //
  // Note the value: real Chrome reports `false`, not `undefined` — the
  // property exists and is specified to be false when not under automation,
  // so returning `undefined` would be its own tell.
  safe(() => {
    if (navigator.webdriver !== true) return;
    defineNativeGetter(Navigator.prototype, "webdriver", false);
  });

  // ── window.chrome ──────────────────────────────────────────────────────────
  // Absent in some headless/CDP launches; real Chrome always exposes it.
  safe(() => {
    if (window.chrome) return;
    window.chrome = {
      runtime: {},
      app: { isInstalled: false },
      csi: asNative(function csi() {
        return {};
      }, "csi"),
      loadTimes: asNative(function loadTimes() {
        return {};
      }, "loadTimes"),
    };
  });

  // ── navigator.plugins / navigator.mimeTypes ────────────────────────────────
  // Only if the browser reports none. Current Chrome — headless included —
  // already exposes 5 PDF plugin entries and 2 PDF mime types as genuine
  // PluginArray/MimeTypeArray objects; replacing those with fakes would be a
  // pure downgrade. When they are empty, rebuild them with the real prototypes,
  // since detectors check those rather than just the length.
  safe(() => {
    if (navigator.plugins && navigator.plugins.length > 0) return;

    const pdfMimes = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
    ];
    const pluginNames = [
      "PDF Viewer",
      "Chrome PDF Viewer",
      "Chromium PDF Viewer",
      "Microsoft Edge PDF Viewer",
      "WebKit built-in PDF",
    ];

    /** Build an array-like with the given prototype, indexed + named access. */
    const makeList = (proto, items, keyOf) => {
      const list = Object.create(proto);
      const named = Object.create(null);
      items.forEach((item, i) => {
        Object.defineProperty(list, i, { value: item, enumerable: true });
        named[keyOf(item)] = item;
      });
      Object.defineProperty(list, "length", { value: items.length });
      Object.defineProperty(list, "item", {
        value: asNative(function item(i) {
          return items[i] ?? null;
        }, "item"),
      });
      Object.defineProperty(list, "namedItem", {
        value: asNative(function namedItem(name) {
          return named[name] ?? null;
        }, "namedItem"),
      });
      return list;
    };

    const mimeTypes = pdfMimes.map((m) =>
      Object.assign(Object.create(MimeType.prototype), m)
    );
    const plugins = pluginNames.map((name) => {
      const plugin = Object.assign(Object.create(Plugin.prototype), {
        name,
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
        length: mimeTypes.length,
      });
      mimeTypes.forEach((m, i) =>
        Object.defineProperty(plugin, i, { value: m, enumerable: true })
      );
      return plugin;
    });

    // Cross-link: real mimeTypes point back at their enabled plugin.
    mimeTypes.forEach((m) =>
      Object.defineProperty(m, "enabledPlugin", { value: plugins[0] })
    );

    defineNativeGetter(
      Navigator.prototype,
      "plugins",
      makeList(PluginArray.prototype, plugins, (p) => p.name)
    );
    defineNativeGetter(
      Navigator.prototype,
      "mimeTypes",
      makeList(MimeTypeArray.prototype, mimeTypes, (m) => m.type)
    );
  });

  // ── navigator.languages ────────────────────────────────────────────────────
  // Only if empty. WorkerNavigator.languages exists and can't be patched, so
  // overwriting a real locale would create a worker mismatch.
  safe(() => {
    if (navigator.languages && navigator.languages.length) return;
    defineNativeGetter(Navigator.prototype, "languages", ["en-US", "en"]);
  });

  // ── Permissions API: deliberately not patched ──────────────────────────────
  // Old headless Chrome reported notifications as "denied" while
  // Notification.permission said "default", and stealth libraries patch
  // permissions.query to fix it. Current Chrome (including headless) reports
  // "prompt" correctly, so there is nothing to fix — and the mismatch can only
  // be detected asynchronously, which means the patch would have to wrap a
  // native method on every page just in case. A wrapper that never lies is
  // pure detection surface, and it would drag in the toString cloak below.

  // ── WebGL vendor / renderer ────────────────────────────────────────────────
  // Only when the real renderer is a software rasteriser (SwiftShader,
  // llvmpipe, Mesa offscreen) — the classic headless-on-a-server tell. A
  // hardware GPU string is left completely alone: it's realistic already, and
  // WebGL inside a Worker can't be patched from here, so spoofing it would
  // leak a main-thread-vs-worker mismatch.
  //
  // The renderer is probed up front with a throwaway context, because the
  // decision has to be made *before* installing anything: a wrapper that
  // turns out never to lie would still cost us the toString cloak below.
  safe(() => {
    const UNMASKED_VENDOR = 37445;
    const UNMASKED_RENDERER = 37446;
    const SOFTWARE_RENDERER = /swiftshader|llvmpipe|mesa offscreen|softwarerasterizer/i;

    let realRenderer = "";
    const canvas = document.createElement("canvas");
    const probe =
      canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!probe) return;
    const info = probe.getExtension("WEBGL_debug_renderer_info");
    if (info) {
      realRenderer = String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL));
    }
    const lose = probe.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();

    // Real GPU — leave WebGL completely untouched.
    if (!SOFTWARE_RENDERER.test(realRenderer)) return;

    const spoof = (proto) => {
      if (!proto) return;
      const original = proto.getParameter;
      const getParameter = asNative(function getParameter(parameter) {
        if (parameter === UNMASKED_VENDOR) return "Intel Inc.";
        if (parameter === UNMASKED_RENDERER) return "Intel Iris OpenGL Engine";
        return original.call(this, parameter);
      }, "getParameter");
      proto.getParameter = getParameter;
    };

    spoof(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    spoof(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  });

  // ── Install the toString cloak, only if there's something to cloak ─────────
  // Nothing was patched (the common case on a current Chrome) => leave
  // Function.prototype.toString completely alone, so there is no stack-trace
  // seam for a fingerprinter to find.
  safe(() => {
    if (patchCount === 0) return;
    const toString = function toString() {
      const name = nativeNames.get(this);
      if (name !== undefined) return `function ${name}() { [native code] }`;
      return nativeToString.call(this);
    };
    nativeNames.set(toString, "toString");
    Function.prototype.toString = toString;
  });
})();
