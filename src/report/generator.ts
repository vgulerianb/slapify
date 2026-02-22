import fs from "fs";
import path from "path";
import { TestResult, StepResult, ReportConfig } from "../types.js";

/**
 * Generate test reports in various formats
 */
export class ReportGenerator {
  private config: ReportConfig;

  constructor(config: ReportConfig = {}) {
    this.config = {
      format: "html",
      screenshots: true,
      output_dir: "./test-reports",
      ...config,
    };
  }

  /**
   * Generate a report from test results
   */
  generate(result: TestResult): string {
    switch (this.config.format) {
      case "markdown":
        return this.generateMarkdown(result);
      case "html":
        return this.generateHTML(result);
      case "json":
        return JSON.stringify(result, null, 2);
      default:
        return this.generateHTML(result);
    }
  }

  /**
   * Generate a suite report from multiple test results
   */
  generateSuiteReport(results: TestResult[]): string {
    return this.generateSuiteHTML(results);
  }

  /**
   * Save report to file
   */
  save(result: TestResult, filename?: string): string {
    const report = this.generate(result);

    // Ensure output directory exists
    const outputDir = this.config.output_dir || "./test-reports";
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate filename
    const ext =
      this.config.format === "html"
        ? "html"
        : this.config.format === "json"
        ? "json"
        : "md";
    const defaultName = `${path.basename(
      result.flowFile,
      ".flow"
    )}-${Date.now()}.${ext}`;
    const outputPath = path.join(outputDir, filename || defaultName);

    fs.writeFileSync(outputPath, report);
    return outputPath;
  }

  /**
   * Save report as a folder with embedded images
   */
  saveAsFolder(result: TestResult): string {
    const outputDir = this.config.output_dir || "./test-reports";
    const folderName = `${path.basename(
      result.flowFile,
      ".flow"
    )}-${Date.now()}`;
    const reportFolder = path.join(outputDir, folderName);

    // Create report folder
    fs.mkdirSync(reportFolder, { recursive: true });

    // Copy screenshots to folder and build map
    const screenshotMap: Record<string, string> = {};
    for (const step of result.steps) {
      if (step.screenshot && fs.existsSync(step.screenshot)) {
        const screenshotName = path.basename(step.screenshot);
        const destPath = path.join(reportFolder, screenshotName);
        fs.copyFileSync(step.screenshot, destPath);
        screenshotMap[step.screenshot] = screenshotName;

        // Clean up original screenshot
        try {
          fs.unlinkSync(step.screenshot);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Update result with relative paths
    const updatedResult = {
      ...result,
      steps: result.steps.map((step) => ({
        ...step,
        screenshot: step.screenshot
          ? screenshotMap[step.screenshot] || step.screenshot
          : undefined,
      })),
    };

    // Generate report
    const report = this.generateHTML(updatedResult);
    const reportPath = path.join(reportFolder, "report.html");
    fs.writeFileSync(reportPath, report);

    return reportFolder;
  }

  /**
   * Save suite report as a folder
   */
  saveSuiteAsFolder(results: TestResult[]): string {
    const outputDir = this.config.output_dir || "./test-reports";
    const folderName = `test-suite-${Date.now()}`;
    const reportFolder = path.join(outputDir, folderName);

    // Create report folder
    fs.mkdirSync(reportFolder, { recursive: true });

    // Copy all screenshots and update paths
    const updatedResults = results.map((result) => {
      const screenshotMap: Record<string, string> = {};
      for (const step of result.steps) {
        if (step.screenshot && fs.existsSync(step.screenshot)) {
          const screenshotName = `${path.basename(
            result.flowFile,
            ".flow"
          )}-${path.basename(step.screenshot)}`;
          const destPath = path.join(reportFolder, screenshotName);
          fs.copyFileSync(step.screenshot, destPath);
          screenshotMap[step.screenshot] = screenshotName;
          try {
            fs.unlinkSync(step.screenshot);
          } catch {}
        }
      }

      return {
        ...result,
        steps: result.steps.map((step) => ({
          ...step,
          screenshot: step.screenshot
            ? screenshotMap[step.screenshot] || step.screenshot
            : undefined,
        })),
      };
    });

    // Generate suite report
    const report = this.generateSuiteHTML(updatedResults);
    const reportPath = path.join(reportFolder, "report.html");
    fs.writeFileSync(reportPath, report);

    return reportFolder;
  }

  /**
   * Generate Markdown report
   */
  private generateMarkdown(result: TestResult): string {
    const lines: string[] = [];

    const statusEmoji = result.status === "passed" ? "✅" : "❌";
    lines.push(`# ${path.basename(result.flowFile, ".flow")}`);
    lines.push("");
    lines.push(`**Status:** ${statusEmoji} ${result.status.toUpperCase()}`);
    lines.push(`**Duration:** ${this.formatDuration(result.duration)}`);
    lines.push(`**Started:** ${result.startTime.toISOString()}`);
    lines.push("");

    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Steps | ${result.totalSteps} |`);
    lines.push(`| Passed | ${result.passedSteps} |`);
    lines.push(`| Failed | ${result.failedSteps} |`);
    lines.push(`| Skipped | ${result.skippedSteps} |`);
    lines.push("");

    if (result.autoHandled.length > 0) {
      lines.push("## Auto-Handled");
      for (const handled of result.autoHandled) {
        lines.push(`- ${handled}`);
      }
      lines.push("");
    }

    lines.push("## Steps");
    lines.push("");

    for (const stepResult of result.steps) {
      const step = stepResult.step;
      const statusIcon =
        stepResult.status === "passed"
          ? "✅"
          : stepResult.status === "failed"
          ? "❌"
          : "⏭️";
      const optional = step.optional ? " [Optional]" : "";

      lines.push(`### ${statusIcon} ${step.text}${optional}`);
      lines.push(`Duration: ${this.formatDuration(stepResult.duration)}`);
      lines.push("");

      if (stepResult.actions.length > 0) {
        for (const action of stepResult.actions) {
          lines.push(`- ${action.description}`);
        }
        lines.push("");
      }

      if (stepResult.error) {
        lines.push(`**Error:** ${stepResult.error}`);
        lines.push("");
      }

      if (stepResult.screenshot) {
        lines.push(`![Screenshot](./${stepResult.screenshot})`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Generate HTML report with Tailwind CSS
   */
  private generateHTML(result: TestResult): string {
    const statusIcon = result.status === "passed" ? "✓" : "✗";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${path.basename(result.flowFile, ".flow")} - Test Report</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .step-details { display: none; }
    .step.expanded .step-details { display: block; }
    .step.expanded .chevron { transform: rotate(180deg); }
    .modal { display: none; }
    .modal.active { display: flex; }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <div class="max-w-4xl mx-auto p-6">
    
    <!-- Header -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-bold">${path.basename(
          result.flowFile,
          ".flow"
        )}</h1>
        <span class="px-4 py-2 rounded-full font-semibold text-sm ${
          result.status === "passed"
            ? "bg-green-100 text-green-800"
            : "bg-red-100 text-red-800"
        }">
          ${statusIcon} ${result.status.toUpperCase()}
        </span>
      </div>
      <p class="text-gray-500 text-sm mb-6">Duration: ${this.formatDuration(
        result.duration
      )} · ${result.startTime.toLocaleString()}</p>
      
      <!-- Stats -->
      <div class="grid grid-cols-4 gap-4">
        <div class="bg-gray-100 rounded-lg p-4 text-center">
          <div class="text-3xl font-bold">${result.totalSteps}</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide">Total</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-4 text-center">
          <div class="text-3xl font-bold text-green-600">${
            result.passedSteps
          }</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide">Passed</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-4 text-center">
          <div class="text-3xl font-bold text-red-600">${
            result.failedSteps
          }</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide">Failed</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-4 text-center">
          <div class="text-3xl font-bold text-yellow-600">${
            result.skippedSteps
          }</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide">Skipped</div>
        </div>
      </div>
    </div>

    ${
      result.autoHandled.length > 0
        ? `
    <!-- Auto-handled -->
    <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
      <div class="font-semibold text-blue-800 mb-2">ℹ️ Auto-Handled Interruptions</div>
      ${result.autoHandled
        .map((h) => `<div class="text-blue-700 text-sm py-1">• ${h}</div>`)
        .join("")}
    </div>
    `
        : ""
    }

    ${result.perfAudit ? this.formatPerfSectionHTML(result.perfAudit) : ""}

    <!-- Steps -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 font-semibold">Steps</div>
      ${result.steps.map((s, i) => this.formatStepHTML(s, i)).join("")}
    </div>
    
    <!-- Footer -->
    <div class="text-center text-gray-400 text-sm py-8">
      Generated by Slapify · ${new Date().toISOString()}
    </div>
  </div>

  <!-- Modal -->
  <div class="modal fixed inset-0 bg-black/90 z-50 items-center justify-center cursor-pointer" id="modal">
    <img src="" alt="Screenshot" id="modal-img" class="max-w-[95%] max-h-[95%] rounded-lg">
  </div>

  <script>
    document.querySelectorAll('.step-header').forEach(header => {
      header.addEventListener('click', () => header.parentElement.classList.toggle('expanded'));
    });
    
    const modal = document.getElementById('modal');
    const modalImg = document.getElementById('modal-img');
    
    document.querySelectorAll('.screenshot-img').forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        modalImg.src = img.src;
        modal.classList.add('active');
      });
    });
    
    modal.addEventListener('click', () => modal.classList.remove('active'));
    document.querySelectorAll('.step.failed').forEach(step => step.classList.add('expanded'));
  </script>
</body>
</html>`;
  }

  /**
   * Format a single step for HTML with Tailwind
   */
  private formatStepHTML(result: StepResult, index: number): string {
    const step = result.step;
    const statusIcon =
      result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "○";
    const statusColors = {
      passed: "bg-green-100 text-green-600",
      failed: "bg-red-100 text-red-600",
      skipped: "bg-yellow-100 text-yellow-600",
    };
    const hasScreenshot = !!result.screenshot;
    const wasRetried = result.retried;

    return `
    <div class="step ${result.status} border-b border-gray-100 last:border-b-0">
      <div class="step-header flex items-center px-6 py-4 cursor-pointer hover:bg-gray-50 transition-colors">
        <div class="w-8 h-8 rounded-full flex items-center justify-center font-semibold text-sm mr-4 flex-shrink-0 ${
          statusColors[result.status]
        }">${statusIcon}</div>
        <div class="flex-1 min-w-0">
          <div class="font-medium flex items-center flex-wrap gap-2">
            <span>${step.text}</span>
            ${
              step.optional
                ? '<span class="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded">Optional</span>'
                : ""
            }
            ${
              wasRetried
                ? '<span class="px-2 py-0.5 bg-orange-100 text-orange-600 text-xs rounded">Retried</span>'
                : ""
            }
          </div>
          ${
            result.actions.length > 0
              ? `<div class="text-sm text-gray-500 mt-1 truncate">${
                  result.actions[0]?.description || ""
                }</div>`
              : ""
          }
        </div>
        <div class="flex items-center gap-3 ml-4">
          ${hasScreenshot ? '<span class="text-gray-400" title="Has screenshot">📷</span>' : ""}
          <span class="text-gray-400 text-sm">${this.formatDuration(result.duration)}</span>
        </div>
        <div class="chevron ml-2 text-gray-400 transition-transform">▼</div>
      </div>
      <div class="step-details px-6 pb-6 pl-16">
        ${
          result.actions.length > 0
            ? `
        <div class="bg-gray-50 rounded-lg p-4 mb-4">
          ${result.actions
            .map(
              (a) =>
                `<div class="py-1 text-sm"><span class="mr-2">${this.getActionIcon(
                  a.type
                )}</span>${a.description}</div>`
            )
            .join("")}
        </div>
        `
            : ""
        }
        ${
          result.assumptions && result.assumptions.length > 0
            ? `
        <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
          <div class="font-semibold text-yellow-800 mb-2">💡 Assumptions</div>
          ${result.assumptions
            .map(
              (a) => `<div class="text-yellow-700 text-sm py-1">• ${a}</div>`
            )
            .join("")}
        </div>
        `
            : ""
        }
        ${
          result.error
            ? `<div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 font-mono text-sm text-red-700 whitespace-pre-wrap break-words">${result.error}</div>`
            : ""
        }
        ${
          result.screenshot
            ? `
        <div class="mt-4">
          <img src="./${result.screenshot}" alt="Step ${
                index + 1
              }" loading="lazy" class="screenshot-img max-w-full rounded-lg border border-gray-200 cursor-pointer hover:shadow-lg transition-shadow">
        </div>
        `
            : ""
        }
      </div>
    </div>`;
  }

  /**
   * Generate suite report HTML with Tailwind
   */
  private generateSuiteHTML(results: TestResult[]): string {
    const totalTests = results.length;
    const passedTests = results.filter((r) => r.status === "passed").length;
    const failedTests = results.filter((r) => r.status === "failed").length;
    const totalSteps = results.reduce((sum, r) => sum + r.totalSteps, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    const overallStatus = failedTests === 0 ? "passed" : "failed";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Suite Report</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .test-details { display: none; }
    .test-item.expanded .test-details { display: block; }
    .test-item.expanded .chevron { transform: rotate(180deg); }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <div class="max-w-5xl mx-auto p-6">
    
    <!-- Header -->
    <div class="bg-white rounded-xl shadow-sm p-8 mb-6">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-3xl font-bold">Test Suite Report</h1>
        <span class="px-6 py-3 rounded-full font-bold ${
          overallStatus === "passed"
            ? "bg-green-100 text-green-800"
            : "bg-red-100 text-red-800"
        }">
          ${overallStatus === "passed" ? "✓ ALL PASSED" : "✗ FAILURES"}
        </span>
      </div>
      
      <!-- Stats -->
      <div class="grid grid-cols-5 gap-4">
        <div class="bg-gray-100 rounded-lg p-5 text-center">
          <div class="text-4xl font-bold">${totalTests}</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide mt-1">Test Files</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-5 text-center">
          <div class="text-4xl font-bold text-green-600">${passedTests}</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide mt-1">Passed</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-5 text-center">
          <div class="text-4xl font-bold text-red-600">${failedTests}</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide mt-1">Failed</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-5 text-center">
          <div class="text-4xl font-bold">${totalSteps}</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide mt-1">Total Steps</div>
        </div>
        <div class="bg-gray-100 rounded-lg p-5 text-center">
          <div class="text-2xl font-bold">${this.formatDuration(
            totalDuration
          )}</div>
          <div class="text-xs text-gray-500 uppercase tracking-wide mt-1">Duration</div>
        </div>
      </div>
    </div>

    <!-- Test List -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 font-semibold text-lg">Test Files (${totalTests})</div>
      ${results.map((r, i) => this.formatTestItemHTML(r, i)).join("")}
    </div>
    
    <!-- Footer -->
    <div class="text-center text-gray-400 text-sm py-8">
      Generated by Slapify · ${new Date().toISOString()}
    </div>
  </div>

  <script>
    document.querySelectorAll('.test-header').forEach(header => {
      header.addEventListener('click', () => header.parentElement.classList.toggle('expanded'));
    });
    document.querySelectorAll('.test-item.failed').forEach(item => item.classList.add('expanded'));
  </script>
</body>
</html>`;
  }

  /**
   * Format a test item for suite report with Tailwind
   */
  private formatTestItemHTML(result: TestResult, index: number): string {
    const statusIcon = result.status === "passed" ? "✓" : "✗";
    const statusColors =
      result.status === "passed"
        ? "bg-green-100 text-green-600"
        : "bg-red-100 text-red-600";

    return `
    <div class="test-item ${
      result.status
    } border-b border-gray-100 last:border-b-0">
      <div class="test-header flex items-center px-6 py-5 cursor-pointer hover:bg-gray-50 transition-colors">
        <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold mr-4 ${statusColors}">${statusIcon}</div>
        <div class="flex-1">
          <div class="font-semibold text-lg">${path.basename(
            result.flowFile,
            ".flow"
          )}</div>
          <div class="text-sm text-gray-500 mt-1">${
            result.totalSteps
          } steps · ${this.formatDuration(result.duration)}</div>
        </div>
        <div class="flex gap-2 ml-4">
          <span class="px-3 py-1 bg-green-100 text-green-700 rounded text-sm font-medium">${
            result.passedSteps
          } passed</span>
          ${
            result.failedSteps > 0
              ? `<span class="px-3 py-1 bg-red-100 text-red-700 rounded text-sm font-medium">${result.failedSteps} failed</span>`
              : ""
          }
        </div>
        <div class="chevron ml-4 text-gray-400 transition-transform">▼</div>
      </div>
      <div class="test-details px-6 pb-6 bg-gray-50">
        ${result.steps
          .map((s) => {
            const stepColors = {
              passed: "bg-green-100 text-green-600",
              failed: "bg-red-100 text-red-600",
              skipped: "bg-yellow-100 text-yellow-600",
            };
            const stepIcon =
              s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : "○";
            return `
            <div class="flex items-center py-2 text-sm">
              <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs mr-3 ${
                stepColors[s.status]
              }">${stepIcon}</div>
              <div class="flex-1">${s.step.text}</div>
              <div class="text-gray-400">${this.formatDuration(
                s.duration
              )}</div>
            </div>
            ${
              s.error
                ? `<div class="ml-9 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 mb-2">${s.error}</div>`
                : ""
            }
          `;
          })
          .join("")}
      </div>
    </div>`;
  }

  /**
   * Format duration in human-readable form
   */
  private formatPerfSectionHTML(perf: import("../perf/audit.js").PerfAuditResult): string {
    const scoreGauge = (score: number, label: string): string => {
      const color = score >= 90 ? "#16a34a" : score >= 50 ? "#d97706" : "#dc2626";
      const bg    = score >= 90 ? "bg-green-50 border-green-200" : score >= 50 ? "bg-yellow-50 border-yellow-200" : "bg-red-50 border-red-200";
      const text  = score >= 90 ? "text-green-700" : score >= 50 ? "text-yellow-700" : "text-red-700";
      const c = 2 * Math.PI * 28;
      return `<div class="flex flex-col items-center p-4 rounded-xl border ${bg} min-w-[100px]">
        <svg width="64" height="64" viewBox="0 0 72 72" class="mb-2">
          <circle cx="36" cy="36" r="28" fill="none" stroke="#e5e7eb" stroke-width="8"/>
          <circle cx="36" cy="36" r="28" fill="none" stroke="${color}" stroke-width="8"
            stroke-dasharray="${((score/100)*c).toFixed(1)} ${c.toFixed(1)}"
            stroke-linecap="round" transform="rotate(-90 36 36)"/>
          <text x="36" y="41" text-anchor="middle" fill="${color}" font-size="16" font-weight="700">${score}</text>
        </svg>
        <div class="text-xs font-semibold text-gray-600">${label}</div>
        <div class="text-xs ${text}">${score >= 90 ? "Good" : score >= 50 ? "Needs Work" : "Poor"}</div>
      </div>`;
    };

    const vitalBadge = (name: string, val: number | undefined, unit: string, thresholds: [number, number]): string => {
      if (val == null) return "";
      const color = val <= thresholds[0] ? "text-green-700 bg-green-50 border-green-200"
                  : val <= thresholds[1] ? "text-yellow-700 bg-yellow-50 border-yellow-200"
                  : "text-red-700 bg-red-50 border-red-200";
      const display = unit === "" ? val.toFixed(4) : `${val}${unit}`;
      return `<div class="flex items-center justify-between px-4 py-2 rounded-lg border ${color}">
        <span class="text-xs font-medium text-gray-600">${name}</span>
        <span class="text-sm font-bold ml-4">${display}</span>
      </div>`;
    };

    const lhGauges = perf.lighthouse
      ? [
          scoreGauge(perf.lighthouse.performance, "Performance"),
          scoreGauge(perf.lighthouse.accessibility, "Accessibility"),
          scoreGauge(perf.lighthouse.bestPractices, "Best Practices"),
          scoreGauge(perf.lighthouse.seo, "SEO"),
        ].join("")
      : "";

    const vitals = [
      vitalBadge("FCP",  perf.vitals.fcp,  "ms", [1800, 3000]),
      vitalBadge("LCP",  perf.vitals.lcp,  "ms", [2500, 4000]),
      vitalBadge("CLS",  perf.vitals.cls,  "",   [0.1,  0.25]),
      vitalBadge("TTFB", perf.vitals.ttfb, "ms", [800,  1800]),
      vitalBadge("DOM Ready", perf.vitals.domContentLoaded, "ms", [2000, 4000]),
    ].filter(Boolean).join("");

    const lhMetrics = perf.lighthouse
      ? [
          ["FCP",  perf.lighthouse.fcp,        "ms"],
          ["LCP",  perf.lighthouse.lcp,        "ms"],
          ["TBT",  perf.lighthouse.tbt,        "ms"],
          ["Speed Index", perf.lighthouse.speedIndex, "ms"],
          ["TTI",  perf.lighthouse.tti,        "ms"],
        ].filter(([, v]) => v != null)
          .map(([l, v, u]) => `<div class="bg-gray-100 rounded-lg p-3 text-center">
            <div class="text-xs text-gray-500">${l}</div>
            <div class="text-lg font-bold">${v}${u}</div>
          </div>`).join("")
      : "";

    const reactSection = perf.react
      ? perf.react.detected
        ? `<div class="mt-4 pt-4 border-t border-gray-200">
            <div class="font-semibold text-sm mb-3">⚛️ React Scan${perf.react.version ? ` <span class="text-gray-400 font-normal">v${perf.react.version}</span>` : ""}</div>
            ${perf.react.issues.length === 0
              ? `<p class="text-green-600 text-sm">✅ No unnecessary re-renders detected</p>`
              : `<div class="space-y-1">${perf.react.issues.map(i =>
                  `<div class="flex items-center justify-between text-sm px-3 py-2 bg-yellow-50 rounded-lg border border-yellow-200">
                    <code class="text-yellow-800">${i.component}</code>
                    <span class="text-red-600 font-semibold">${i.renderCount} renders${i.avgMs != null ? ` · ${i.avgMs}ms avg` : ""}</span>
                  </div>`).join("")}</div>`
            }
          </div>`
        : `<p class="text-gray-400 text-sm mt-4">ℹ️ React not detected on this page</p>`
      : "";

    return `
    <!-- Performance -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <div class="font-semibold text-lg mb-1">⚡ Performance Audit</div>
      <div class="text-xs text-gray-400 mb-4">${perf.url}</div>

      ${lhGauges ? `<div class="flex flex-wrap gap-3 mb-6">${lhGauges}</div>` : ""}

      ${lhMetrics ? `<div class="grid grid-cols-3 gap-3 mb-4">${lhMetrics}</div>` : ""}

      ${vitals ? `
      <div class="mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Core Web Vitals (live)</div>
      <div class="grid grid-cols-2 gap-2 mb-2">${vitals}</div>` : ""}

      ${reactSection}

      ${perf.lighthouseReportPath ? `<div class="mt-4 text-xs text-gray-400">Full Lighthouse report: <a href="${perf.lighthouseReportPath}" class="text-blue-500 underline">${perf.lighthouseReportPath}</a></div>` : ""}
    </div>`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }

  /**
   * Get icon for action type
   */
  private getActionIcon(type: string): string {
    switch (type) {
      case "navigate":
        return "🔗";
      case "click":
        return "👆";
      case "fill":
        return "✏️";
      case "verify":
        return "✓";
      case "wait":
        return "⏳";
      case "auto-handle":
        return "ℹ️";
      default:
        return "•";
    }
  }

  /**
   * Print summary to console
   */
  printSummary(result: TestResult): void {
    const statusEmoji = result.status === "passed" ? "✅" : "❌";

    console.log("");
    console.log(
      `${statusEmoji} ${path.basename(
        result.flowFile,
        ".flow"
      )} - ${result.status.toUpperCase()}`
    );
    console.log(
      `   ${result.passedSteps}/${
        result.totalSteps
      } steps passed (${this.formatDuration(result.duration)})`
    );
  }
}
