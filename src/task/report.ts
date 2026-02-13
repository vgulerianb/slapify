import fs from "fs";
import path from "path";
import { TaskSession, SessionEvent } from "./types.js";
import type { PerfAuditResult, NetworkAnalysis } from "../perf/audit.js";

export interface TaskReport {
  session: TaskSession;
  events: SessionEvent[];
  generatedAt: string;
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "scheduled":
      return "#3b82f6";
    case "sleeping":
      return "#a78bfa";
    default:
      return "#f59e0b";
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "scheduled":
      return "⏰";
    case "sleeping":
      return "😴";
    default:
      return "⟳";
  }
}

function toolIcon(toolName: string): string {
  const icons: Record<string, string> = {
    navigate: "🌐",
    get_page_state: "📄",
    click: "🖱️",
    type: "⌨️",
    press: "⌨️",
    scroll: "↕️",
    wait: "⏳",
    screenshot: "📸",
    reload: "🔄",
    go_back: "⬅️",
    list_credential_profiles: "🔑",
    inject_credentials: "💉",
    fill_login_form: "🔐",
    save_credentials: "💾",
    remember: "🧠",
    recall: "🔍",
    list_memories: "📚",
    schedule: "⏰",
    sleep_until: "😴",
    done: "✅",
    fetch_url: "⚡",
    status_update: "📢",
    ask_user: "🙋",
  };
  return icons[toolName] || "🔧";
}

function perfScoreColor(score: number): string {
  if (score >= 90) return "#22c55e";
  if (score >= 50) return "#f59e0b";
  return "#ef4444";
}

function perfScoreLabel(score: number): string {
  if (score >= 90) return "Good";
  if (score >= 50) return "Needs Improvement";
  return "Poor";
}

function vitalRating(name: string, value: number): string {
  const thresholds: Record<string, [number, number]> = {
    fcp: [1800, 3000],
    lcp: [2500, 4000],
    cls: [0.1, 0.25],
    ttfb: [800, 1800],
    tbt: [200, 600],
  };
  const t = thresholds[name];
  if (!t) return "#94a3b8";
  if (value <= t[0]) return "#22c55e";
  if (value <= t[1]) return "#f59e0b";
  return "#ef4444";
}

function fmt(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function renderNetworkSection(net: NetworkAnalysis | undefined): string {
  if (!net) return "";

  const th = `style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:5px 10px"`;
  const td = (color = "#e2e8f0") =>
    `style="color:${color};padding:5px 10px;font-size:0.8rem"`;

  // ── Summary pills ─────────────────────────────────────────────────────────
  const pill = (label: string, value: string, color = "#94a3b8") =>
    `<div style="background:#1e293b;border-radius:8px;padding:10px 14px;min-width:100px">
      <div style="font-size:0.68rem;color:#64748b">${label}</div>
      <div style="font-size:1rem;font-weight:700;color:${color};margin-top:2px">${value}</div>
    </div>`;

  const pills = [
    pill("Requests", String(net.totalRequests)),
    pill(
      "Total Size",
      fmt(net.totalBytes),
      net.totalBytes > 2_000_000 ? "#f87171" : "#e2e8f0"
    ),
    pill(
      "JavaScript",
      fmt(net.jsBytes),
      net.jsBytes > 500_000 ? "#f59e0b" : "#e2e8f0"
    ),
    pill("CSS", fmt(net.cssBytes)),
    pill("Images", fmt(net.imageBytes)),
    pill(
      "Long Tasks",
      String(net.longTasks.length),
      net.longTasks.length > 3 ? "#f59e0b" : "#e2e8f0"
    ),
    pill(
      "Blocking JS",
      `${net.totalBlockingMs}ms`,
      net.totalBlockingMs > 300
        ? "#f87171"
        : net.totalBlockingMs > 100
        ? "#f59e0b"
        : "#22c55e"
    ),
    ...(net.memoryMB != null ? [pill("JS Heap", `${net.memoryMB} MB`)] : []),
  ].join("");

  // ── Heaviest resources ────────────────────────────────────────────────────
  const heavyRows = net.heaviestResources
    .filter((r) => r.size > 0)
    .map(
      (r) =>
        `<tr>
          <td ${td()}>${escHtml(r.url.split("/").slice(-3).join("/"))}</td>
          <td ${td("#94a3b8")}>${r.type}</td>
          <td ${td(
            r.size > 500_000
              ? "#f87171"
              : r.size > 100_000
              ? "#f59e0b"
              : "#86efac"
          )}>${fmt(r.size)}</td>
          <td ${td("#64748b")}>${r.duration}ms</td>
          ${
            r.renderBlocking
              ? `<td style="color:#f87171;font-size:0.75rem;padding:5px 10px">⚠ blocking</td>`
              : `<td></td>`
          }
        </tr>`
    )
    .join("");

  const heavyTable = heavyRows
    ? `<div style="margin-top:16px">
        <h4 style="font-size:0.8rem;font-weight:600;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Heaviest Resources</h4>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th ${th}>URL</th><th ${th}>Type</th><th ${th}>Size</th><th ${th}>Load</th><th ${th}></th>
          </tr></thead>
          <tbody>${heavyRows}</tbody>
        </table>
      </div>`
    : "";

  // ── API calls ─────────────────────────────────────────────────────────────
  const apiRows = net.apiCalls
    .slice(0, 20)
    .map((r) => {
      const isSlow = r.duration >= 500;
      const statusColor = r.failed ? "#f87171" : "#86efac";
      return `<tr>
        <td ${td("#7dd3fc")}>${escHtml(r.method)}</td>
        <td ${td()}>${escHtml(
        r.url.length > 80 ? "…" + r.url.slice(-80) : r.url
      )}</td>
        <td ${td(statusColor)}>${r.status || "err"}</td>
        <td ${td(
          isSlow ? "#f87171" : r.duration > 200 ? "#f59e0b" : "#86efac"
        )}>${r.duration}ms${isSlow ? " ⚠" : ""}</td>
      </tr>`;
    })
    .join("");

  const apiTable = apiRows
    ? `<div style="margin-top:16px">
        <h4 style="font-size:0.8rem;font-weight:600;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">
          API Calls <span style="color:#64748b;font-weight:400;font-size:0.72rem">${
            net.failedApiCalls.length > 0
              ? `· ${net.failedApiCalls.length} failed`
              : ""
          }${
        net.slowApiCalls.length > 0 ? ` · ${net.slowApiCalls.length} slow` : ""
      }</span>
        </h4>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th ${th}>Method</th><th ${th}>URL</th><th ${th}>Status</th><th ${th}>Time</th>
          </tr></thead>
          <tbody>${apiRows}</tbody>
        </table>
      </div>`
    : "";

  // ── Long tasks ────────────────────────────────────────────────────────────
  const longTaskRows = net.longTasks
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 8)
    .map(
      (t) =>
        `<tr>
          <td ${td(t.duration > 200 ? "#f87171" : "#f59e0b")}>${
          t.duration
        }ms</td>
          <td ${td("#64748b")}>at ${t.startTime}ms</td>
        </tr>`
    )
    .join("");

  const longTaskTable =
    longTaskRows && net.longTasks.length > 0
      ? `<div style="margin-top:16px">
          <h4 style="font-size:0.8rem;font-weight:600;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">
            Long Tasks <span style="color:#64748b;font-weight:400;font-size:0.72rem">(JS blocking main thread &gt;50ms)</span>
          </h4>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr><th ${th}>Duration</th><th ${th}>When</th></tr></thead>
            <tbody>${longTaskRows}</tbody>
          </table>
        </div>`
      : "";

  return `
    <div style="border-top:1px solid #1e293b;margin-top:24px;padding-top:20px">
      <h3 style="font-size:0.9rem;font-weight:600;color:#e2e8f0;margin-bottom:14px">🌐 Network & Runtime</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:4px">${pills}</div>
      ${heavyTable}
      ${apiTable}
      ${longTaskTable}
    </div>`;
}

function renderPerfSection(perf: PerfAuditResult): string {
  // Support both old .lighthouse and new .scores field names
  const scores = perf.scores ?? perf.lighthouse ?? null;

  const gauges = scores
    ? ["performance", "accessibility", "bestPractices", "seo"]
        .map((key) => {
          const score = (scores as unknown as Record<string, number>)[key] ?? 0;
          const label =
            key === "bestPractices"
              ? "Best Practices"
              : key.charAt(0).toUpperCase() + key.slice(1);
          const color = perfScoreColor(score);
          const circumference = 2 * Math.PI * 28;
          const dash = (score / 100) * circumference;
          return `<div style="text-align:center;min-width:100px">
            <svg width="72" height="72" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="28" fill="none" stroke="#1e293b" stroke-width="8"/>
              <circle cx="36" cy="36" r="28" fill="none" stroke="${color}" stroke-width="8"
                stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(
            1
          )}"
                stroke-linecap="round" transform="rotate(-90 36 36)"/>
              <text x="36" y="41" text-anchor="middle" fill="${color}" font-size="16" font-weight="700">${score}</text>
            </svg>
            <div style="font-size:0.72rem;color:#94a3b8;margin-top:4px">${label}</div>
            <div style="font-size:0.68rem;color:${color}">${perfScoreLabel(
            score
          )}</div>
          </div>`;
        })
        .join("")
    : "";

  const vitalsRows = Object.entries(perf.vitals)
    .filter(([, v]) => v != null)
    .map(([key, value]) => {
      const display =
        key === "cls" ? (value as number).toFixed(4) : `${value}ms`;
      const color = vitalRating(key, value as number);
      const labels: Record<string, string> = {
        fcp: "First Contentful Paint",
        lcp: "Largest Contentful Paint",
        cls: "Cumulative Layout Shift",
        ttfb: "Time to First Byte",
        domContentLoaded: "DOM Content Loaded",
        loadComplete: "Load Complete",
      };
      return `<tr>
        <td style="color:#94a3b8;padding:6px 12px;font-size:0.8rem">${
          labels[key] || key
        }</td>
        <td style="color:${color};padding:6px 12px;font-size:0.8rem;font-weight:600">${display}</td>
      </tr>`;
    })
    .join("");

  const labMetrics = scores
    ? [
        ["FCP", scores.fcp, "ms"],
        ["LCP", scores.lcp, "ms"],
        ["CLS", scores.cls?.toFixed(4), ""],
        ["TBT", scores.tbt, "ms"],
        ["Speed Index", scores.speedIndex, "ms"],
        ["TTI", scores.tti, "ms"],
      ]
        .filter(([, v]) => v != null)
        .map(
          ([label, value, unit]) =>
            `<div style="background:#1e293b;border-radius:8px;padding:12px 16px;min-width:120px">
              <div style="font-size:0.72rem;color:#64748b">${label}</div>
              <div style="font-size:1.1rem;font-weight:700;color:#e2e8f0;margin-top:2px">${value}${unit}</div>
            </div>`
        )
        .join("")
    : "";

  // Framework badge (strip outer parens: "(Next.js)" → "Next.js")
  const reactVer = perf.react?.version;
  const frameworkName = reactVer?.startsWith("(")
    ? reactVer.slice(1, -1)
    : reactVer;
  const frameworkBadge = frameworkName
    ? ` <span style="color:#64748b;font-weight:400;font-size:0.8rem">${escHtml(
        frameworkName
      )}</span>`
    : "";

  // Passive render issues table
  const renderIssuesHtml =
    perf.react?.detected && (perf.react.issues?.length ?? 0) > 0
      ? `<table style="width:100%;border-collapse:collapse;margin-top:8px">
          <thead><tr>
            <th style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:6px 12px">Component</th>
            <th style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:6px 12px">Renders</th>
            ${
              perf.react.issues[0]?.avgMs != null
                ? '<th style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:6px 12px">Avg Time</th>'
                : ""
            }
          </tr></thead>
          <tbody>
            ${perf.react.issues
              .map(
                (i) =>
                  `<tr>
                    <td style="color:#fcd34d;padding:6px 12px;font-size:0.8rem;font-family:monospace">${escHtml(
                      i.component
                    )}</td>
                    <td style="color:#f87171;padding:6px 12px;font-size:0.8rem;font-weight:600">${
                      i.renderCount
                    }</td>
                    ${
                      i.avgMs != null
                        ? `<td style="color:#94a3b8;padding:6px 12px;font-size:0.8rem">${i.avgMs}ms</td>`
                        : ""
                    }
                  </tr>`
              )
              .join("")}
          </tbody>
        </table>`
      : "";

  // Interaction test results table
  const interactionTests = perf.react?.interactionTests ?? [];
  const interactionHtml =
    interactionTests.length > 0
      ? `<div style="margin-top:16px">
          <h4 style="font-size:0.8rem;font-weight:600;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Interaction Tests</h4>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:6px 12px">Action</th>
              <th style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:6px 12px">DOM Changes</th>
              <th style="text-align:left;color:#64748b;font-size:0.72rem;text-transform:uppercase;padding:6px 12px">Status</th>
            </tr></thead>
            <tbody>
              ${interactionTests
                .map(
                  (t) =>
                    `<tr>
                      <td style="color:#e2e8f0;padding:6px 12px;font-size:0.8rem">${escHtml(
                        t.action
                      )}</td>
                      <td style="color:${
                        t.flagged ? "#f87171" : "#86efac"
                      };padding:6px 12px;font-size:0.8rem;font-weight:600">${
                      t.mutations
                    }</td>
                      <td style="padding:6px 12px;font-size:0.8rem">${
                        t.flagged
                          ? '<span style="color:#f87171">⚠ High activity</span>'
                          : '<span style="color:#86efac">✓ Normal</span>'
                      }</td>
                    </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`
      : "";

  const frameworkSection = perf.react?.detected
    ? `<div style="margin-top:24px">
        <h3 style="font-size:0.9rem;font-weight:600;color:#e2e8f0;margin-bottom:12px">⚛️ Framework Analysis${frameworkBadge}</h3>
        ${
          renderIssuesHtml
            ? renderIssuesHtml
            : `<p style="color:#22c55e;font-size:0.85rem">✅ No passive re-render issues detected</p>`
        }
        ${interactionHtml}
      </div>`
    : perf.react?.detected === false
    ? `<p style="color:#64748b;font-size:0.85rem;margin-top:16px">ℹ️ No component framework detected on this page</p>`
    : "";

  return `
    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:24px;margin-bottom:32px">
      <h2 style="font-size:1.1rem;font-weight:600;color:#e2e8f0;margin-bottom:20px">⚡ Performance
        <span style="font-size:0.75rem;font-weight:400;color:#64748b;margin-left:8px">${escHtml(
          perf.url
        )}</span>
      </h2>

      ${
        gauges
          ? `<div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:24px">${gauges}</div>`
          : ""
      }

      ${
        labMetrics
          ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${labMetrics}</div>`
          : ""
      }

      ${
        vitalsRows
          ? `<div style="margin-bottom:16px">
              <h3 style="font-size:0.85rem;font-weight:600;color:#94a3b8;margin-bottom:8px">Real User Metrics</h3>
              <table style="border-collapse:collapse"><tbody>${vitalsRows}</tbody></table>
            </div>`
          : ""
      }

      ${frameworkSection}

      ${renderNetworkSection(perf.network)}

      ${
        perf.lighthouseReportPath
          ? `<p style="margin-top:16px;font-size:0.78rem;color:#64748b">Full report: <a href="${escHtml(
              perf.lighthouseReportPath
            )}" style="color:#7dd3fc">${escHtml(
              perf.lighthouseReportPath
            )}</a></p>`
          : ""
      }
    </div>`;
}

/**
 * Renders either a single audit section or, when multiple pages were audited,
 * a URL tab bar + the selected page's full detail panel.
 */
function renderAllPerfSections(session: TaskSession): string {
  const audits =
    session.perfAudits ?? (session.perfAudit ? [session.perfAudit] : []);
  if (audits.length === 0) return "";
  if (audits.length === 1) return renderPerfSection(audits[0]);

  const pageLabel = (a: PerfAuditResult) => {
    try {
      return new URL(a.url).pathname || "/";
    } catch {
      return a.url;
    }
  };

  const tabs = audits
    .map(
      (a, i) => `
    <button
      id="slp-tab-${i}"
      onclick="slpSwitch(${i})"
      title="${escHtml(a.url)}"
      style="
        cursor:pointer;background:none;border:none;outline:none;
        padding:9px 18px;font-size:0.82rem;font-weight:500;white-space:nowrap;
        border-bottom:2px solid ${i === 0 ? "#7c3aed" : "transparent"};
        color:${i === 0 ? "#e2e8f0" : "#64748b"};
        transition:color .15s,border-color .15s;
      "
    >${escHtml(pageLabel(a))}</button>`
    )
    .join("");

  const panels = audits
    .map(
      (a, i) =>
        `<div id="slp-panel-${i}" style="display:${
          i === 0 ? "block" : "none"
        }">${renderPerfSection(a)}</div>`
    )
    .join("");

  const script = `
    <script>
      function slpSwitch(idx) {
        var n = ${audits.length};
        for (var i = 0; i < n; i++) {
          var p = document.getElementById('slp-panel-' + i);
          var t = document.getElementById('slp-tab-' + i);
          var active = i === idx;
          if (p) p.style.display = active ? 'block' : 'none';
          if (t) {
            t.style.borderBottomColor = active ? '#7c3aed' : 'transparent';
            t.style.color = active ? '#e2e8f0' : '#64748b';
          }
        }
      }
    <\/script>`;

  return `
    <div>
      <div style="display:flex;flex-wrap:wrap;border-bottom:1px solid #1e293b;margin-bottom:20px;overflow-x:auto">
        ${tabs}
      </div>
      ${panels}
    </div>
    ${script}`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `<span class="arg-key">${escHtml(
        k
      )}</span><span class="arg-eq">=</span><span class="arg-val">${escHtml(
        val.slice(0, 120)
      )}${val.length > 120 ? "…" : ""}</span>`;
    })
    .join(" &nbsp; ");
}

function formatResult(result: unknown): string {
  const s = typeof result === "string" ? result : JSON.stringify(result);
  return escHtml(s.slice(0, 300)) + (s.length > 300 ? "…" : "");
}

export function generateTaskReportHtml(report: TaskReport): string {
  const { session, events } = report;
  const durationMs =
    new Date(session.updatedAt).getTime() -
    new Date(session.createdAt).getTime();
  const durationStr =
    durationMs < 60000
      ? `${Math.round(durationMs / 1000)}s`
      : `${Math.floor(durationMs / 60000)}m ${Math.round(
          (durationMs % 60000) / 1000
        )}s`;

  const timelineRows = events
    .filter((e) =>
      [
        "tool_call",
        "tool_error",
        "memory_update",
        "scheduled",
        "sleeping_until",
        "session_end",
        "llm_response",
      ].includes(e.type)
    )
    .map((event) => {
      const ts = new Date(event.ts).toLocaleTimeString();
      if (event.type === "tool_call") {
        const icon = toolIcon(event.toolName);
        const isDone = event.toolName === "done";
        return `
        <tr class="${isDone ? "row-done" : "row-tool"}">
          <td class="cell-time">${ts}</td>
          <td class="cell-icon">${icon}</td>
          <td class="cell-tool"><span class="tag-tool">${escHtml(
            event.toolName
          )}</span></td>
          <td class="cell-args">${formatArgs(event.args)}</td>
          <td class="cell-result result-ok">${formatResult(event.result)}</td>
        </tr>`;
      }
      if (event.type === "tool_error") {
        const icon = toolIcon(event.toolName);
        return `
        <tr class="row-error">
          <td class="cell-time">${ts}</td>
          <td class="cell-icon">${icon}</td>
          <td class="cell-tool"><span class="tag-tool tag-error">${escHtml(
            event.toolName
          )}</span></td>
          <td class="cell-args">${formatArgs(event.args)}</td>
          <td class="cell-result result-error">${escHtml(event.error)}</td>
        </tr>`;
      }
      if (event.type === "memory_update") {
        return `
        <tr class="row-memory">
          <td class="cell-time">${ts}</td>
          <td class="cell-icon">🧠</td>
          <td class="cell-tool"><span class="tag-memory">remember</span></td>
          <td class="cell-args"><span class="arg-key">${escHtml(
            event.key
          )}</span> = <span class="arg-val">${escHtml(
          event.value.slice(0, 120)
        )}</span></td>
          <td class="cell-result result-ok">stored</td>
        </tr>`;
      }
      if (event.type === "scheduled") {
        return `
        <tr class="row-scheduled">
          <td class="cell-time">${ts}</td>
          <td class="cell-icon">⏰</td>
          <td class="cell-tool"><span class="tag-scheduled">schedule</span></td>
          <td class="cell-args"><span class="arg-key">cron</span>=<span class="arg-val">${escHtml(
            event.cron
          )}</span></td>
          <td class="cell-result result-ok">${escHtml(event.task)}</td>
        </tr>`;
      }
      if (event.type === "sleeping_until") {
        return `
        <tr class="row-sleeping">
          <td class="cell-time">${ts}</td>
          <td class="cell-icon">😴</td>
          <td class="cell-tool"><span class="tag-sleeping">sleep</span></td>
          <td class="cell-args"></td>
          <td class="cell-result result-ok">until ${escHtml(
            new Date(event.until).toLocaleString()
          )}</td>
        </tr>`;
      }
      if (event.type === "llm_response" && event.text) {
        const preview = event.text.slice(0, 300);
        return `
        <tr class="row-think">
          <td class="cell-time">${ts}</td>
          <td class="cell-icon">💬</td>
          <td class="cell-tool"><span class="tag-think">thought</span></td>
          <td class="cell-args" colspan="2"><span class="markdown-inline" data-md="${escHtml(
            preview
          )}${event.text.length > 300 ? "…" : ""}"></span></td>
        </tr>`;
      }
      return "";
    })
    .join("\n");

  const memoryRows = Object.entries(session.memory)
    .map(
      ([k, v]) => `
      <tr>
        <td class="mem-key">${escHtml(k)}</td>
        <td class="mem-val">${escHtml(v)}</td>
      </tr>`
    )
    .join("\n");

  const scheduledRows = session.scheduledJobs
    .map(
      (j) => `
      <tr>
        <td>${escHtml(j.cron)}</td>
        <td>${escHtml(j.taskDescription)}</td>
        <td>${j.lastRun ? new Date(j.lastRun).toLocaleString() : "—"}</td>
      </tr>`
    )
    .join("\n");

  // Summary is stored as raw markdown text — rendered by marked.js in the browser
  const summaryHtml = session.finalSummary
    ? `<div class="summary-box markdown-body" data-md="${escHtml(
        session.finalSummary
      )}"></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Task Report — ${escHtml(session.goal.slice(0, 60))}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
    .summary-box { background: #1e293b; border-left: 4px solid #22c55e; padding: 1rem 1.5rem; border-radius: 0.5rem; font-size: 0.95rem; line-height: 1.7; }
    /* Markdown prose styles inside summary and thought cells */
    .markdown-body h1,.markdown-body h2,.markdown-body h3 { font-weight: 700; margin: 0.75em 0 0.35em; color: #f1f5f9; }
    .markdown-body h1 { font-size: 1.25rem; }
    .markdown-body h2 { font-size: 1.05rem; }
    .markdown-body h3 { font-size: 0.95rem; }
    .markdown-body p  { margin: 0.4em 0; }
    .markdown-body ul,.markdown-body ol { padding-left: 1.4em; margin: 0.4em 0; }
    .markdown-body li { margin: 0.15em 0; }
    .markdown-body strong { color: #f8fafc; font-weight: 600; }
    .markdown-body em    { color: #cbd5e1; }
    .markdown-body code  { background: #0f172a; color: #7dd3fc; padding: 1px 5px; border-radius: 4px; font-size: 0.85em; font-family: monospace; }
    .markdown-body pre   { background: #0f172a; border-radius: 6px; padding: 0.75rem 1rem; overflow-x: auto; margin: 0.5em 0; }
    .markdown-body pre code { background: none; padding: 0; }
    .markdown-body hr    { border-color: #334155; margin: 0.75em 0; }
    .markdown-body blockquote { border-left: 3px solid #475569; padding-left: 0.75rem; color: #94a3b8; margin: 0.4em 0; }
    .markdown-body table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 0.85rem; }
    .markdown-body th   { background: #1e293b; color: #94a3b8; padding: 6px 12px; text-align: left; font-weight: 600; border: 1px solid #334155; }
    .markdown-body td   { padding: 5px 12px; border: 1px solid #1e293b; color: #e2e8f0; }
    .markdown-body tr:nth-child(even) td { background: #0f1b2d; }
    /* Inline thought text (smaller, muted) */
    .markdown-inline p  { margin: 0; display: inline; }
    .markdown-inline    { color: #94a3b8; font-size: 0.82rem; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #1e293b; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.6rem 0.75rem; text-align: left; }
    td { padding: 0.45rem 0.75rem; font-size: 0.82rem; border-bottom: 1px solid #1e293b; vertical-align: top; }
    tr:hover td { background: #1e293b55; }
    .cell-time { color: #64748b; font-family: monospace; white-space: nowrap; width: 70px; }
    .cell-icon { font-size: 1rem; text-align: center; width: 30px; }
    .cell-tool { white-space: nowrap; }
    .cell-args { color: #94a3b8; font-size: 0.78rem; }
    .arg-key { color: #7dd3fc; }
    .arg-eq { color: #64748b; }
    .arg-val { color: #fcd34d; }
    .tag-tool { background: #1e40af33; color: #93c5fd; padding: 1px 7px; border-radius: 999px; font-size: 0.73rem; }
    .tag-error { background: #7f1d1d44; color: #fca5a5; }
    .tag-memory { background: #4c1d9544; color: #c4b5fd; padding: 1px 7px; border-radius: 999px; font-size: 0.73rem; }
    .tag-scheduled { background: #164e6344; color: #67e8f9; padding: 1px 7px; border-radius: 999px; font-size: 0.73rem; }
    .tag-sleeping { background: #3b0764; color: #d8b4fe; padding: 1px 7px; border-radius: 999px; font-size: 0.73rem; }
    .tag-think { background: #422006; color: #fde68a; padding: 1px 7px; border-radius: 999px; font-size: 0.73rem; }
    .result-ok { color: #86efac; }
    .result-error { color: #fca5a5; }
    .row-done td { background: #14532d22; }
    .row-error td { background: #7f1d1d22; }
    .row-memory td { background: #1a0533; }
    .row-scheduled td { background: #0c4a6e22; }
    .row-sleeping td { background: #150a33; }
    .row-think td { background: #1c1a00; }
    .mem-key { color: #7dd3fc; font-family: monospace; width: 220px; }
    .mem-val { color: #fde68a; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
    .stat-card { background: #1e293b; border-radius: 0.75rem; padding: 1.25rem 1.5rem; }
    .stat-num { font-size: 2rem; font-weight: 700; line-height: 1; }
    .stat-label { font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; }
  </style>
</head>
<body class="min-h-screen">
  <div class="max-w-6xl mx-auto px-4 py-10">
    <div class="mb-8">
      <div class="flex items-center gap-3 mb-1">
        <span class="text-2xl">🤖</span>
        <h1 class="text-2xl font-bold text-white">Task Report</h1>
        <span style="color:${statusColor(
          session.status
        )}" class="ml-2 text-lg">${statusIcon(session.status)} ${
    session.status
  }</span>
      </div>
      <p class="text-slate-400 text-sm mt-1 font-mono">${escHtml(
        session.id
      )}</p>
      <p class="text-slate-200 text-base mt-3 font-medium">"${escHtml(
        session.goal
      )}"</p>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div class="stat-card">
        <div class="stat-num text-blue-400">${session.iteration}</div>
        <div class="stat-label">Iterations</div>
      </div>
      <div class="stat-card">
        <div class="stat-num text-green-400">${durationStr}</div>
        <div class="stat-label">Duration</div>
      </div>
      <div class="stat-card">
        <div class="stat-num text-purple-400">${
          Object.keys(session.memory).length
        }</div>
        <div class="stat-label">Memory Items</div>
      </div>
      <div class="stat-card">
        <div class="stat-num text-cyan-400">${
          session.scheduledJobs.length
        }</div>
        <div class="stat-label">Scheduled Jobs</div>
      </div>
    </div>

    ${
      summaryHtml
        ? `
    <div class="mb-8">
      <h2 class="text-lg font-semibold text-white mb-3">📋 Summary</h2>
      ${summaryHtml}
    </div>`
        : ""
    }

    ${renderAllPerfSections(session)}

    ${
      memoryRows
        ? `
    <div class="mb-8">
      <h2 class="text-lg font-semibold text-white mb-3">🧠 Memory at Completion</h2>
      <div class="rounded-lg overflow-hidden border border-slate-700">
        <table>
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>${memoryRows}</tbody>
        </table>
      </div>
    </div>`
        : ""
    }

    ${
      scheduledRows
        ? `
    <div class="mb-8">
      <h2 class="text-lg font-semibold text-white mb-3">⏰ Scheduled Jobs</h2>
      <div class="rounded-lg overflow-hidden border border-slate-700">
        <table>
          <thead><tr><th>Cron</th><th>Task</th><th>Last Run</th></tr></thead>
          <tbody>${scheduledRows}</tbody>
        </table>
      </div>
    </div>`
        : ""
    }

    <div class="mb-8">
      <h2 class="text-lg font-semibold text-white mb-3">📜 Action Timeline</h2>
      <div class="rounded-lg overflow-hidden border border-slate-700">
        <table>
          <thead>
            <tr><th>Time</th><th></th><th>Action</th><th>Arguments</th><th>Result</th></tr>
          </thead>
          <tbody>${timelineRows}</tbody>
        </table>
      </div>
    </div>

    <p class="text-center text-slate-600 text-xs mt-8">
      Generated by Slapify Task Agent &bull; ${new Date(
        report.generatedAt
      ).toLocaleString()}
      &bull; Session: ${escHtml(session.id)}
    </p>
  </div>

  <script>
    // Render all markdown blocks once marked.js is loaded
    (function renderMarkdown() {
      if (typeof marked === 'undefined') {
        // Retry after CDN script loads
        window.addEventListener('load', renderMarkdown);
        return;
      }
      marked.setOptions({ breaks: true, gfm: true });

      // Summary box — full markdown prose
      document.querySelectorAll('.markdown-body[data-md]').forEach(function(el) {
        el.innerHTML = marked.parse(el.getAttribute('data-md') || '');
      });

      // Inline thought previews — strip to plain text then render inline
      document.querySelectorAll('.markdown-inline[data-md]').forEach(function(el) {
        el.innerHTML = marked.parseInline(el.getAttribute('data-md') || '');
      });
    })();
  </script>
</body>
</html>`;
}

export function saveTaskReport(
  session: TaskSession,
  events: SessionEvent[],
  outputDir?: string
): string {
  const dir = outputDir || path.join(process.cwd(), "slapify-task-reports");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, `${session.id}.html`);
  const html = generateTaskReportHtml({
    session,
    events,
    generatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(reportPath, html);
  return reportPath;
}
