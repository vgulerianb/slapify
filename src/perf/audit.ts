/**
 * Performance auditing module — four independent layers:
 *   1. Core Web Vitals  — injected into running browser, zero extra deps
 *   2. Network analysis — resource timing + fetch/XHR interception + long tasks
 *   3. Framework        — React/Next.js detection + re-render analysis with interactions
 *   4. Deep audit       — isolated headless Chrome for cold-start throttled scores
 */

import { BrowserAgent } from "../browser/agent.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebVitals {
  /** First Contentful Paint (ms) */
  fcp?: number;
  /** Largest Contentful Paint (ms) */
  lcp?: number;
  /** Cumulative Layout Shift */
  cls?: number;
  /** Time to First Byte (ms) */
  ttfb?: number;
  /** DOM Content Loaded (ms) */
  domContentLoaded?: number;
  /** Page fully loaded (ms) */
  loadComplete?: number;
}

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  // Core Web Vitals from Lighthouse
  fcp?: number;
  lcp?: number;
  cls?: number;
  /** Total Blocking Time (ms) */
  tbt?: number;
  /** Speed Index */
  speedIndex?: number;
  /** Time to Interactive (ms) */
  tti?: number;
}

export interface ReactScanResult {
  detected: boolean;
  version?: string;
  /** Components with static-passive re-render issues (from react-scan) */
  issues: Array<{
    component: string;
    renderCount: number;
    avgMs?: number;
  }>;
  /**
   * Results of simulated user interactions — each entry describes what was
   * clicked, how many DOM mutations it triggered, and whether that count is
   * suspiciously high.
   */
  interactionTests?: Array<{
    action: string;
    mutations: number;
    flagged: boolean;
  }>;
}

/** A single network request captured via fetch/XHR interception */
export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  /** Response time in ms */
  duration: number;
  type: "fetch" | "xhr";
  /** true for 4xx/5xx or network error */
  failed?: boolean;
}

/** A resource loaded by the browser (script, stylesheet, image, font…) */
export interface ResourceEntry {
  url: string;
  type: string;
  /** Transfer size in bytes (0 if served from cache) */
  size: number;
  /** Uncompressed body size in bytes */
  encodedSize: number;
  /** Load duration in ms */
  duration: number;
  /** true if this resource blocked first render */
  renderBlocking?: boolean;
}

/** A JavaScript task that blocked the main thread for >50ms */
export interface LongTask {
  /** Duration in ms */
  duration: number;
  startTime: number;
}

export interface NetworkAnalysis {
  /** Total number of resources loaded */
  totalRequests: number;
  /** Uncompressed bytes transferred (resources only) */
  totalBytes: number;
  /** Bytes from JS files */
  jsBytes: number;
  /** Bytes from CSS files */
  cssBytes: number;
  /** Bytes from images */
  imageBytes: number;
  /** Resources that blocked rendering */
  renderBlockingCount: number;
  /** Top 10 heaviest resources */
  heaviestResources: ResourceEntry[];
  /** API calls captured during the session (fetch + XHR) */
  apiCalls: NetworkRequest[];
  /** API calls slower than 500ms */
  slowApiCalls: NetworkRequest[];
  /** API calls that returned an error status */
  failedApiCalls: NetworkRequest[];
  /** Long tasks (JS blocking main thread >50ms) */
  longTasks: LongTask[];
  /** Total main-thread blocking time from long tasks (ms) */
  totalBlockingMs: number;
  /** JS heap size in MB, if available */
  memoryMB?: number;
}

export interface PerfAuditResult {
  url: string;
  auditedAt: string;
  /** Always collected from the live browser session */
  vitals: WebVitals;
  /** null when the deep audit is unavailable or disabled */
  scores: LighthouseScores | null;
  /** null when framework not detected or analysis disabled */
  react: ReactScanResult | null;
  /** Network analysis — resource sizes, API calls, long tasks */
  network?: NetworkAnalysis;
  /** @deprecated use scores */
  lighthouse?: LighthouseScores | null;
  /** Path to full audit HTML report, if saved */
  lighthouseReportPath?: string;
}

export interface PerfAuditOptions {
  /** Run deep performance audit (default: true) */
  lighthouse?: boolean;
  /** Analyse framework re-renders including interaction tests (default: true) */
  reactScan?: boolean;
  /** Wait this many ms after page load before collecting vitals (default: 2000) */
  settleMs?: number;
  /** Save full audit HTML report to this directory */
  lighthouseOutputDir?: string;
  /**
   * Navigate to `url` before auditing (default: true for task agent).
   * Set to false when the browser is already on the target page (flow runner).
   */
  navigate?: boolean;
}

// ─── Core Web Vitals injection ────────────────────────────────────────────────

/**
 * Injects a PerformanceObserver into the current page that collects
 * FCP, LCP, CLS and also reads Navigation Timing for TTFB / DOM ready.
 * Call collectCoreWebVitals() after some settle time to harvest results.
 */
export async function injectVitalsObserver(
  browser: BrowserAgent
): Promise<void> {
  const script = `(function(){
    if(window.__slapifyVitals) return;
    window.__slapifyVitals = { fcp: null, lcp: null, cls: 0, observed: false };
    try {
      var fcpObs = new PerformanceObserver(function(list){
        var e = list.getEntriesByName('first-contentful-paint')[0];
        if(e) window.__slapifyVitals.fcp = Math.round(e.startTime);
      });
      fcpObs.observe({ type: 'paint', buffered: true });

      var lcpObs = new PerformanceObserver(function(list){
        var entries = list.getEntries();
        if(entries.length) window.__slapifyVitals.lcp = Math.round(entries[entries.length-1].startTime);
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });

      var clsObs = new PerformanceObserver(function(list){
        list.getEntries().forEach(function(e){
          if(!e.hadRecentInput) window.__slapifyVitals.cls += e.value;
        });
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });

      window.__slapifyVitals.observed = true;
    } catch(err) {}
  })()`;
  try {
    await browser.evaluate(script);
  } catch {
    // CSP may block eval — skip gracefully
  }
}

/**
 * Reads vitals from the injected observer + Navigation Timing API.
 */
export async function collectCoreWebVitals(
  browser: BrowserAgent
): Promise<WebVitals> {
  const script = `(function(){
    var v = window.__slapifyVitals || {};
    var nav = performance.getEntriesByType('navigation')[0] || {};
    return JSON.stringify({
      fcp:  v.fcp  || null,
      lcp:  v.lcp  || null,
      cls:  v.cls != null ? +v.cls.toFixed(4) : null,
      ttfb: nav.responseStart ? Math.round(nav.responseStart) : null,
      domContentLoaded: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadComplete: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null
    });
  })()`;
  try {
    const raw = await browser.evaluate(script);
    // evaluate may wrap in quotes
    const str = raw.startsWith('"') ? JSON.parse(raw) : raw;
    const parsed = JSON.parse(str);
    const vitals: WebVitals = {};
    if (parsed.fcp != null) vitals.fcp = parsed.fcp;
    if (parsed.lcp != null) vitals.lcp = parsed.lcp;
    if (parsed.cls != null) vitals.cls = parsed.cls;
    if (parsed.ttfb != null) vitals.ttfb = parsed.ttfb;
    if (parsed.domContentLoaded != null)
      vitals.domContentLoaded = parsed.domContentLoaded;
    if (parsed.loadComplete != null) vitals.loadComplete = parsed.loadComplete;
    return vitals;
  } catch {
    return {};
  }
}

// ─── Network analysis ─────────────────────────────────────────────────────────

/**
 * Injects fetch/XHR interceptors and a LongTask PerformanceObserver into the
 * page. Must be called BEFORE user interactions or lazy-loading happens so that
 * API calls during the session are captured.
 *
 * Already-completed load-time requests are captured separately via
 * performance.getEntriesByType('resource') in collectNetworkAnalysis().
 */
export async function injectNetworkTrackers(
  browser: BrowserAgent
): Promise<void> {
  const script = `(function(){
    if (window.__slapifyNet) return;
    window.__slapifyNet = { requests: [], longTasks: [] };

    // ── fetch interceptor ──────────────────────────────────────────────────
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
      var url = '';
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && input.url) url = input.url;
      url = url.slice(0, 300);
      var method = (init && init.method) || (input && input.method) || 'GET';
      var t0 = performance.now();
      return _fetch.apply(this, arguments)
        .then(function(r) {
          window.__slapifyNet.requests.push({ url: url, method: method.toUpperCase(), status: r.status, duration: Math.round(performance.now()-t0), type: 'fetch', failed: r.status >= 400 });
          return r;
        })
        .catch(function(e) {
          window.__slapifyNet.requests.push({ url: url, method: method.toUpperCase(), status: 0, duration: Math.round(performance.now()-t0), type: 'fetch', failed: true });
          throw e;
        });
    };

    // ── XHR interceptor ───────────────────────────────────────────────────
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u) {
      this.__slapM = m; this.__slapU = (u||'').toString().slice(0,300);
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      var self = this, t0 = performance.now();
      this.addEventListener('loadend', function() {
        window.__slapifyNet.requests.push({ url: self.__slapU||'', method: (self.__slapM||'GET').toUpperCase(), status: self.status, duration: Math.round(performance.now()-t0), type: 'xhr', failed: self.status >= 400 || self.status === 0 });
      });
      return _send.apply(this, arguments);
    };

    // ── Long task observer ────────────────────────────────────────────────
    try {
      var obs = new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(e) {
          window.__slapifyNet.longTasks.push({ duration: Math.round(e.duration), startTime: Math.round(e.startTime) });
        });
      });
      obs.observe({ type: 'longtask', buffered: true });
    } catch(e) {}
  })()`;
  try {
    await browser.evaluate(script);
  } catch {
    // Ignore CSP errors
  }
}

/**
 * Collects all network data from the page:
 *   - Resource timing (all loaded files — JS, CSS, images, fonts)
 *   - Captured fetch/XHR API calls (from injectNetworkTrackers)
 *   - Long tasks
 *   - JS heap memory if available
 */
export async function collectNetworkAnalysis(
  browser: BrowserAgent
): Promise<NetworkAnalysis | null> {
  const script = `(function(){
    // Resource timing — all loaded files
    var resources = [];
    try {
      performance.getEntriesByType('resource').forEach(function(e) {
        resources.push({
          url: e.name.slice(0, 300),
          type: e.initiatorType || 'other',
          size: e.transferSize || 0,
          encodedSize: e.encodedBodySize || 0,
          duration: Math.round(e.duration),
          renderBlocking: e.renderBlockingStatus === 'blocking'
        });
      });
    } catch(e) {}

    var net = window.__slapifyNet || { requests: [], longTasks: [] };

    // Memory
    var memMB = null;
    try { if (performance.memory) memMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1); } catch(e){}

    return JSON.stringify({ resources: resources, requests: net.requests, longTasks: net.longTasks, memMB: memMB });
  })()`;

  try {
    const raw = await browser.evaluate(script);
    const str = raw.startsWith('"') ? JSON.parse(raw) : raw;
    const data = JSON.parse(str);

    const resources: ResourceEntry[] = data.resources || [];
    const apiCalls: NetworkRequest[] = data.requests || [];
    const longTasks: LongTask[] = data.longTasks || [];

    // Aggregate resource bytes by type
    let totalBytes = 0,
      jsBytes = 0,
      cssBytes = 0,
      imageBytes = 0,
      renderBlockingCount = 0;
    for (const r of resources) {
      totalBytes += r.size || 0;
      if (r.type === "script") jsBytes += r.size || 0;
      else if (r.type === "css" || r.type === "link") cssBytes += r.size || 0;
      else if (r.type === "img" || r.type === "image")
        imageBytes += r.size || 0;
      if (r.renderBlocking) renderBlockingCount++;
    }

    const heaviestResources = [...resources]
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .slice(0, 10);

    const slowApiCalls = apiCalls.filter((r) => r.duration >= 500);
    const failedApiCalls = apiCalls.filter((r) => r.failed);
    const totalBlockingMs = longTasks.reduce((s, t) => s + t.duration, 0);

    const result: NetworkAnalysis = {
      totalRequests: resources.length,
      totalBytes,
      jsBytes,
      cssBytes,
      imageBytes,
      renderBlockingCount,
      heaviestResources,
      apiCalls,
      slowApiCalls,
      failedApiCalls,
      longTasks,
      totalBlockingMs,
    };
    if (data.memMB != null) result.memoryMB = data.memMB;

    return result;
  } catch {
    return null;
  }
}

// ─── React Scan ───────────────────────────────────────────────────────────────

/**
 * Comprehensive React detection that works with:
 *   - Next.js App Router (no __NEXT_DATA__, uses __next_f / _next/static scripts)
 *   - Next.js Pages Router (__NEXT_DATA__ present)
 *   - Create React App, Vite, Remix, Gatsby
 *   - Any React 16–18 app regardless of bundle mode
 *
 * Detection priority:
 *   1. __reactFiber* / __reactProps* on DOM nodes — most reliable for ALL React builds
 *   2. Next.js-specific globals (__NEXT_DATA__, __next_f, next/router)
 *   3. _next/static script tags — present on every Next.js build
 *   4. __REACT_DEVTOOLS_GLOBAL_HOOK__ with active renderers — dev / devtools
 *   5. window.React — legacy / dev / CRA
 *   6. data-reactroot / data-reactid — legacy attributes
 */
const REACT_DETECT_SCRIPT = `(function(){
  // 1. React fiber on DOM nodes — works for ALL production React builds including Next.js App Router.
  //    Scan a broad set of elements; fibers are attached to every rendered node.
  var els = document.querySelectorAll('*');
  var limit = Math.min(els.length, 200);
  for(var i = 0; i < limit; i++) {
    var el = els[i];
    // Only check elements that likely have React attached (skip pure HTML/SVG with no properties)
    var keys;
    try { keys = Object.keys(el); } catch(e) { continue; }
    for(var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if(k.startsWith('__reactFiber') || k.startsWith('__reactProps') || k.startsWith('__reactInternalInstance') || k.startsWith('__reactEventHandlers')) {
        // Detect Next.js via global markers while we're at it
        var framework = (window.__NEXT_DATA__ || window.__next_f || window.next) ? 'Next.js' : 'React';
        return JSON.stringify({ detected: true, framework: framework, version: null });
      }
    }
  }

  // 2. Next.js globals — Pages Router (__NEXT_DATA__), App Router (__next_f streaming chunks)
  if(window.__NEXT_DATA__) return JSON.stringify({ detected: true, framework: 'Next.js (Pages)', version: null });
  if(window.__next_f || (Array.isArray(window.nd) && window.nd.length)) return JSON.stringify({ detected: true, framework: 'Next.js (App Router)', version: null });

  // 3. _next/static script tags — present on every Next.js deployment
  var scripts = document.querySelectorAll('script[src*="/_next/static"]');
  if(scripts.length > 0) return JSON.stringify({ detected: true, framework: 'Next.js', version: null });

  // 4. DevTools hook with active renderers (dev mode or React DevTools extension)
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if(hook && hook.renderers && hook.renderers.size > 0)
    return JSON.stringify({ detected: true, framework: 'React', version: null });

  // 5. window.React (dev builds / CRA / explicit exposure)
  if(window.React) return JSON.stringify({ detected: true, framework: 'React', version: window.React.version || null });

  // 6. Legacy attributes
  if(document.querySelector('[data-reactroot],[data-reactid]'))
    return JSON.stringify({ detected: true, framework: 'React (legacy)', version: null });

  return JSON.stringify({ detected: false, framework: null, version: null });
})()`;

/**
 * Injects React Scan from unpkg into the current page.
 * Uses comprehensive detection so Next.js / production builds are caught.
 * Does NOT cache detection state — always re-detects to avoid stale negatives.
 */
export async function injectReactScan(browser: BrowserAgent): Promise<void> {
  const script = `(function(){
    // Always re-detect; do not skip based on prior state — prior detection
    // might have been a false negative from an old browser session.
    var raw = ${REACT_DETECT_SCRIPT};
    var info = JSON.parse(typeof raw === 'string' ? raw : '{"detected":false}');
    window.__reactDetection = info;
    if(!info.detected) return;

    // Only inject react-scan once per page load
    if(window.__reactScanInjected) return;
    window.__reactScanInjected = true;

    var s = document.createElement('script');
    s.src = 'https://unpkg.com/react-scan/dist/auto.global.js';
    s.onload = function(){
      try {
        if(window.reactScan) window.reactScan.setOptions({ enabled: true, showToolbar: false });
      } catch(e) {}
    };
    document.head.appendChild(s);
  })()`;
  try {
    await browser.evaluate(script);
  } catch {
    // Ignore CSP errors
  }
}

/**
 * Simulates real user interactions on the page and measures DOM mutation
 * activity triggered by each action. This gives a practical signal for
 * "how much work does the UI do when a user clicks something" without
 * requiring framework-specific hooks.
 *
 * Finds visible interactive elements (buttons, tabs, toggles), clicks each
 * one, waits for mutations to settle, then reports a count. A high mutation
 * count (>50) is flagged as potentially excessive.
 */
async function performInteractionTests(
  browser: BrowserAgent
): Promise<ReactScanResult["interactionTests"]> {
  const results: NonNullable<ReactScanResult["interactionTests"]> = [];

  // Setup MutationObserver and find visible interactive elements
  const setupScript = `(function(){
    window.__slapifyMutCount = 0;
    if (window.__slapifyMutObs) { try { window.__slapifyMutObs.disconnect(); } catch(e){} }
    window.__slapifyMutObs = new MutationObserver(function(records) {
      records.forEach(function(r) {
        window.__slapifyMutCount += r.addedNodes.length + r.removedNodes.length + (r.type === 'attributes' ? 1 : 0);
      });
    });
    window.__slapifyMutObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: false });

    var seen = {};
    var found = [];
    var selectors = 'button:not([type="submit"]):not([disabled]), [role="tab"], [role="button"]:not(a), [aria-expanded]';
    document.querySelectorAll(selectors).forEach(function(el) {
      var rect = el.getBoundingClientRect();
      if (el.offsetParent !== null && rect.width > 20 && rect.height > 10) {
        var label = ((el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '')).replace(/\\s+/g, ' ').trim().slice(0, 40);
        if (label && !seen[label]) {
          seen[label] = true;
          found.push(label);
        }
      }
    });
    window.__slapifyInteractables = found.slice(0, 6);
    return JSON.stringify(window.__slapifyInteractables);
  })()`;

  let buttons: string[] = [];
  try {
    const raw = await browser.evaluate(setupScript);
    const s = raw.startsWith('"') ? JSON.parse(raw) : raw;
    buttons = JSON.parse(s) || [];
  } catch {
    return results;
  }

  for (let i = 0; i < buttons.length; i++) {
    try {
      // Reset counter before each interaction
      await browser.evaluate(
        `(function(){ window.__slapifyMutCount = 0; return 'ok'; })()`
      );

      // Perform the click
      const clickResult = await browser.evaluate(
        `(function(){
          var label = window.__slapifyInteractables[${i}];
          var selectors = 'button:not([type="submit"]):not([disabled]), [role="tab"], [role="button"]:not(a), [aria-expanded]';
          var target = Array.from(document.querySelectorAll(selectors)).find(function(el) {
            var t = ((el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '')).replace(/\\s+/g, ' ').trim().slice(0, 40);
            return t === label;
          });
          if (!target) return 'not_found';
          try { target.click(); return 'clicked'; } catch(e) { return 'error'; }
        })()`
      );

      if (!clickResult.includes("clicked")) continue;

      // Wait for mutations to settle (Node.js side — eval is synchronous per call)
      await new Promise((r) => setTimeout(r, 800));

      // Collect mutation count
      const countRaw = await browser.evaluate(
        `(function(){ return String(window.__slapifyMutCount || 0); })()`
      );
      const mutations = parseInt(countRaw.replace(/\D/g, "")) || 0;

      results.push({
        action: `Clicked: ${buttons[i]}`,
        mutations,
        flagged: mutations > 50,
      });
    } catch {
      // Non-fatal — skip this interaction
    }
  }

  // Tear down observer
  try {
    await browser.evaluate(
      `(function(){ if(window.__slapifyMutObs){ window.__slapifyMutObs.disconnect(); window.__slapifyMutObs=null; } return 'ok'; })()`
    );
  } catch {
    // ignore
  }

  return results;
}

/**
 * Collects framework detection and re-render analysis results.
 * Always runs fresh detection — never relies on a cached window.__reactDetection
 * that might have been set to {detected:false} by an older code path.
 */
export async function collectReactScanResults(
  browser: BrowserAgent
): Promise<ReactScanResult | null> {
  // Run fresh detection every time for reliability
  const detectScript = `(function(){
    var raw = ${REACT_DETECT_SCRIPT};
    var detection = JSON.parse(typeof raw === 'string' ? raw : '{"detected":false}');
    return JSON.stringify({
      isReact: detection.detected,
      framework: detection.framework || null,
      reactVersion: detection.version || (window.React && window.React.version) || null,
      scanAvailable: !!(window.reactScan && window.reactScan.getReport)
    });
  })()`;

  try {
    const raw = await browser.evaluate(detectScript);
    const str = raw.startsWith('"') ? JSON.parse(raw) : raw;
    const info = JSON.parse(str);

    if (!info.isReact) {
      return { detected: false, issues: [] };
    }

    const result: ReactScanResult = {
      detected: true,
      version:
        info.reactVersion ||
        (info.framework ? `(${info.framework})` : undefined),
      issues: [],
    };

    if (info.scanAvailable) {
      const reportScript = `(function(){
        try {
          var report = window.reactScan.getReport();
          if(!report) return 'null';
          var issues = [];
          report.forEach(function(v, k){
            if(v.count > 2) {
              issues.push({ component: k, renderCount: v.count, avgMs: v.time ? +(v.time/v.count).toFixed(1) : null });
            }
          });
          issues.sort(function(a,b){ return b.renderCount - a.renderCount; });
          return JSON.stringify(issues.slice(0, 20));
        } catch(e) { return '[]'; }
      })()`;

      try {
        const rawIssues = await browser.evaluate(reportScript);
        const issuesStr = rawIssues.startsWith('"')
          ? JSON.parse(rawIssues)
          : rawIssues;
        result.issues = JSON.parse(issuesStr) || [];
      } catch {
        // passive scan report not available
      }
    }

    // Interaction-based testing — simulate user clicks and measure activity
    const interactionTests = await performInteractionTests(browser);
    if ((interactionTests ?? []).length > 0) {
      result.interactionTests = interactionTests!;
    }

    return result;
  } catch {
    return null;
  }
}

// ─── Lighthouse ───────────────────────────────────────────────────────────────

/**
 * Runs a full Lighthouse audit against a URL.
 *
 * Lighthouse ALWAYS needs its own fresh Chrome for accurate scores — it applies
 * controlled CPU/network throttling and does multiple cold-start page loads.
 * Reusing the agent-browser session would skew every metric.
 *
 * chrome-launcher is a transitive dependency of lighthouse — we don't need to
 * import it directly. Lighthouse manages Chrome internally.
 *
 * Returns null if lighthouse is unavailable or the audit fails.
 */
export async function runLighthouseAudit(
  url: string,
  outputDir?: string
): Promise<{ scores: LighthouseScores; reportPath?: string } | null> {
  try {
    // Lighthouse manages its own Chrome lifecycle via its bundled chrome-launcher.
    // We only need the lighthouse package itself.
    const { default: lighthouse } = await import("lighthouse");
    // Access chrome-launcher through lighthouse's own node_modules to avoid
    // needing it as a direct dependency.
    const { launch: launchChrome } = await import(
      // @ts-ignore — chrome-launcher is bundled by lighthouse, not by us
      "chrome-launcher"
    );

    const chrome = await launchChrome({
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
    });

    try {
      const runnerResult = await lighthouse(url as any, {
        port: chrome.port,
        output: outputDir ? ["json", "html"] : "json",
        logLevel: "error",
        onlyCategories: [
          "performance",
          "accessibility",
          "best-practices",
          "seo",
        ],
        skipAudits: ["screenshot-thumbnails", "final-screenshot"],
      });

      if (!runnerResult?.lhr) return null;

      const lhr = runnerResult.lhr;
      const cat: Record<string, { score?: number | null }> =
        lhr.categories ?? {};
      const aud: Record<string, { numericValue?: number }> = lhr.audits ?? {};

      const scores: LighthouseScores = {
        performance: Math.round((cat["performance"]?.score ?? 0) * 100),
        accessibility: Math.round((cat["accessibility"]?.score ?? 0) * 100),
        bestPractices: Math.round((cat["best-practices"]?.score ?? 0) * 100),
        seo: Math.round((cat["seo"]?.score ?? 0) * 100),
        fcp:
          aud["first-contentful-paint"]?.numericValue != null
            ? Math.round(aud["first-contentful-paint"].numericValue)
            : undefined,
        lcp:
          aud["largest-contentful-paint"]?.numericValue != null
            ? Math.round(aud["largest-contentful-paint"].numericValue)
            : undefined,
        cls:
          aud["cumulative-layout-shift"]?.numericValue != null
            ? +aud["cumulative-layout-shift"].numericValue.toFixed(4)
            : undefined,
        tbt:
          aud["total-blocking-time"]?.numericValue != null
            ? Math.round(aud["total-blocking-time"].numericValue)
            : undefined,
        speedIndex:
          aud["speed-index"]?.numericValue != null
            ? Math.round(aud["speed-index"].numericValue)
            : undefined,
        tti:
          aud["interactive"]?.numericValue != null
            ? Math.round(aud["interactive"].numericValue)
            : undefined,
      };

      let reportPath: string | undefined;
      if (outputDir && runnerResult.report) {
        const { default: fs } = await import("fs");
        const { default: path } = await import("path");
        fs.mkdirSync(outputDir, { recursive: true });
        const reports = Array.isArray(runnerResult.report)
          ? runnerResult.report
          : [runnerResult.report];
        const htmlReport = reports.find((r: string) => r.startsWith("<!"));
        if (htmlReport) {
          const slug = new URL(url).hostname.replace(/\./g, "-");
          reportPath = path.join(
            outputDir,
            `lighthouse-${slug}-${Date.now()}.html`
          );
          fs.writeFileSync(reportPath, htmlReport);
        }
      }

      return { scores, reportPath };
    } finally {
      await chrome.kill();
    }
  } catch {
    // lighthouse not installed or audit failed — not fatal
    return null;
  }
}

// ─── Full audit orchestrator ──────────────────────────────────────────────────

/**
 * Run a full performance audit while a browser session is already open.
 *
 * CWV + framework analysis are collected from the live browser session.
 * The deep performance audit spins up its own fresh headless Chrome for accurate
 * throttled scores — this is intentional: it needs controlled cold-start
 * conditions that the existing session cannot provide.
 *
 * In the flow runner we avoid the overlap by closing agent-browser first (see
 * runner/index.ts). In the task agent the overlap is brief and acceptable since
 * the user explicitly asked for a perf audit mid-session.
 */
export async function runPerfAudit(
  url: string,
  browser: BrowserAgent,
  options: PerfAuditOptions = {}
): Promise<PerfAuditResult> {
  const {
    lighthouse: runLighthouse = true,
    reactScan: runReactScan = true,
    settleMs = 2000,
    lighthouseOutputDir,
    navigate: shouldNavigate = true,
  } = options;

  // Navigate to the target URL if requested (default for task agent).
  // The flow runner passes navigate:false because the browser is already there.
  if (shouldNavigate) {
    await browser.navigate(url);
    // Brief pause so the page starts loading before we inject observers
    await new Promise((r) => setTimeout(r, 500));
  }

  const result: PerfAuditResult = {
    url,
    auditedAt: new Date().toISOString(),
    vitals: {},
    scores: null,
    react: null,
  };

  // 1. Inject all observers early so they capture everything from here on
  await injectVitalsObserver(browser);
  await injectNetworkTrackers(browser);
  if (runReactScan) {
    await injectReactScan(browser);
  }

  // Allow page to settle and observers to fire
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  // 3. Collect Core Web Vitals
  result.vitals = await collectCoreWebVitals(browser);

  // 4. Collect framework & re-render analysis (includes interaction tests that
  //    also generate real API calls captured by the network tracker)
  if (runReactScan) {
    result.react = await collectReactScanResults(browser);
  }

  // 5. Collect network analysis AFTER interactions so API calls are captured
  result.network = (await collectNetworkAnalysis(browser)) ?? undefined;

  // 5. Run deep performance audit (in separate Chrome, parallel-safe)
  if (runLighthouse) {
    const lhResult = await runLighthouseAudit(url, lighthouseOutputDir);
    if (lhResult) {
      result.scores = lhResult.scores;
      result.lighthouse = lhResult.scores; // backwards compat
      if (lhResult.reportPath)
        result.lighthouseReportPath = lhResult.reportPath;
    }
  }

  return result;
}
