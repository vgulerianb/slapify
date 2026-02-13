// Main exports for programmatic usage

// Task mode
export { runTask, listSessions, loadSession } from "./task/index.js";
export type {
  TaskRunOptions,
  TaskSession,
  TaskEvent,
  TaskStatus,
} from "./task/types.js";

export {
  loadConfig,
  loadCredentials,
  initConfig,
  getConfigDir,
  findSystemBrowsers,
  checkBrowserPath,
} from "./config/loader.js";
export type { InitOptions } from "./config/loader.js";
export {
  parseFlowFile,
  parseFlowContent,
  findFlowFiles,
  validateFlowFile,
  getFlowSummary,
} from "./parser/flow.js";
export { BrowserAgent } from "./browser/agent.js";
export { AIInterpreter } from "./ai/interpreter.js";
export { TestRunner } from "./runner/index.js";
export { ReportGenerator } from "./report/generator.js";

// Export types
export type {
  SlapifyConfig,
  LLMConfig,
  BrowserConfig,
  ReportConfig,
  CredentialsConfig,
  CredentialProfile,
  CookieConfig,
  FlowFile,
  FlowStep,
  StepResult,
  ActionLog,
  TestResult,
  BrowserState,
  RefInfo,
} from "./types.js";

// Convenience class for programmatic usage
import { loadConfig, loadCredentials } from "./config/loader.js";
import {
  parseFlowFile,
  parseFlowContent,
  findFlowFiles,
} from "./parser/flow.js";
import { TestRunner } from "./runner/index.js";
import { ReportGenerator } from "./report/generator.js";
import {
  SlapifyConfig,
  CredentialsConfig,
  FlowFile,
  TestResult,
  StepResult,
} from "./types.js";

export interface SlapifyOptions {
  config?: Partial<SlapifyConfig>;
  credentials?: CredentialsConfig;
  configDir?: string;
}

export interface RunOptions {
  /** Callback for each step completion */
  onStep?: (result: StepResult, testName: string) => void;
  /** Callback when a test starts */
  onTestStart?: (testName: string, totalSteps: number) => void;
  /** Callback when a test completes */
  onTestComplete?: (result: TestResult) => void;
}

export interface RunMultipleOptions extends RunOptions {
  /** Run tests in parallel */
  parallel?: boolean;
  /** Number of parallel workers (default: 4) */
  workers?: number;
}

/**
 * Main Slapify class for programmatic usage
 *
 * @example
 * ```typescript
 * import { Slapify } from 'testpilot';
 *
 * // Using config file
 * const pilot = new Slapify({ configDir: '.testpilot' });
 *
 * // Or with inline config
 * const pilot = new Slapify({
 *   config: {
 *     llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', api_key: process.env.ANTHROPIC_API_KEY },
 *     browser: { headless: true }
 *   }
 * });
 *
 * // Run inline steps
 * const result = await pilot.run([
 *   'Go to https://example.com',
 *   'Click on "More information" link',
 *   'Verify URL contains "iana.org"'
 * ]);
 *
 * console.log(result.status); // 'passed' or 'failed'
 * ```
 */
export class Slapify {
  private config: SlapifyConfig;
  private credentials: CredentialsConfig;
  private reporter: ReportGenerator;

  constructor(options: SlapifyOptions = {}) {
    // Load config from directory or use provided
    if (options.configDir) {
      this.config = { ...loadConfig(options.configDir), ...options.config };
      this.credentials =
        options.credentials || loadCredentials(options.configDir);
    } else if (options.config?.llm) {
      this.config = {
        llm: options.config.llm,
        browser: options.config.browser || { headless: true, timeout: 30000 },
        report: options.config.report || {
          format: "html",
          screenshots: true,
        },
      };
      this.credentials = options.credentials || { profiles: {} };
    } else {
      // Try to load from cwd
      this.config = loadConfig();
      this.credentials = loadCredentials();
    }

    this.reporter = new ReportGenerator(this.config.report);
  }

  /**
   * Create a new runner instance (each test needs its own runner for parallel execution)
   */
  private createRunner(): TestRunner {
    return new TestRunner(this.config, this.credentials);
  }

  /**
   * Run a flow file
   *
   * @example
   * ```typescript
   * const result = await pilot.runFile('tests/login.flow');
   * ```
   */
  async runFile(
    filePath: string,
    options: RunOptions = {}
  ): Promise<TestResult> {
    const flow = parseFlowFile(filePath);
    return this.runFlow(flow, options);
  }

  /**
   * Run steps from an array of strings
   *
   * @example
   * ```typescript
   * const result = await pilot.run([
   *   'Go to https://google.com',
   *   'Fill search box with "testpilot"',
   *   'Press Enter',
   *   'Verify results contain "testpilot"'
   * ], 'google-search');
   * ```
   */
  async run(
    steps: string[],
    name: string = "inline",
    options: RunOptions = {}
  ): Promise<TestResult> {
    const content = steps.join("\n");
    const flow = parseFlowContent(content, name);
    return this.runFlow(flow, options);
  }

  /**
   * Run a flow from string content
   *
   * @example
   * ```typescript
   * const flowContent = `
   *   Go to https://example.com
   *   Click on "More information"
   *   Verify page loads
   * `;
   * const result = await pilot.runContent(flowContent, 'example-test');
   * ```
   */
  async runContent(
    content: string,
    name: string = "inline",
    options: RunOptions = {}
  ): Promise<TestResult> {
    const flow = parseFlowContent(content, name);
    return this.runFlow(flow, options);
  }

  /**
   * Run a parsed flow
   */
  async runFlow(flow: FlowFile, options: RunOptions = {}): Promise<TestResult> {
    const runner = this.createRunner();

    if (options.onTestStart) {
      options.onTestStart(flow.name, flow.steps.length);
    }

    const result = await runner.runFlow(flow, (stepResult) => {
      if (options.onStep) {
        options.onStep(stepResult, flow.name);
      }
    });

    if (options.onTestComplete) {
      options.onTestComplete(result);
    }

    return result;
  }

  /**
   * Run multiple flow files
   *
   * @example
   * ```typescript
   * // Sequential
   * const results = await pilot.runMultiple(['tests/login.flow', 'tests/checkout.flow']);
   *
   * // Parallel with 4 workers
   * const results = await pilot.runMultiple(['tests/*.flow'], { parallel: true, workers: 4 });
   * ```
   */
  async runMultiple(
    patterns: string[],
    options: RunMultipleOptions = {}
  ): Promise<TestResult[]> {
    // Expand patterns to file paths
    const files: string[] = [];
    for (const pattern of patterns) {
      if (pattern.includes("*")) {
        // It's a glob pattern - find matching files
        const found = await findFlowFiles(pattern.replace(/\/\*.*$/, ""));
        files.push(...found);
      } else {
        const fs = await import("fs");
        if (fs.statSync(pattern).isDirectory()) {
          const found = await findFlowFiles(pattern);
          files.push(...found);
        } else {
          files.push(pattern);
        }
      }
    }

    if (files.length === 0) {
      return [];
    }

    const results: TestResult[] = [];

    if (options.parallel && files.length > 1) {
      // Parallel execution
      const workers = options.workers || 4;
      const pending = [...files];
      const running = new Map<string, Promise<void>>();

      while (pending.length > 0 || running.size > 0) {
        // Start new tasks up to worker limit
        while (pending.length > 0 && running.size < workers) {
          const file = pending.shift()!;
          const promise = this.runFile(file, options)
            .then((result) => {
              results.push(result);
              running.delete(file);
            })
            .catch(() => {
              running.delete(file);
            });
          running.set(file, promise);
        }

        // Wait for at least one to complete
        if (running.size > 0) {
          await Promise.race(running.values());
        }
      }
    } else {
      // Sequential execution
      for (const file of files) {
        const result = await this.runFile(file, options);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Run all flow files in a directory
   *
   * @example
   * ```typescript
   * const results = await pilot.runAll('tests/', { parallel: true });
   * ```
   */
  async runAll(
    directory: string = "tests",
    options: RunMultipleOptions = {}
  ): Promise<TestResult[]> {
    return this.runMultiple([directory], options);
  }

  /**
   * Generate a report from results
   */
  generateReport(result: TestResult): string {
    return this.reporter.generate(result);
  }

  /**
   * Generate a suite report from multiple results
   */
  generateSuiteReport(results: TestResult[]): string {
    return this.reporter.generateSuiteReport(results);
  }

  /**
   * Save a report to file/folder
   */
  saveReport(result: TestResult, filename?: string): string {
    return this.reporter.saveAsFolder(result);
  }

  /**
   * Save a suite report to folder
   */
  saveSuiteReport(results: TestResult[]): string {
    return this.reporter.saveSuiteAsFolder(results);
  }

  /**
   * Print summary to console
   */
  printSummary(result: TestResult): void {
    this.reporter.printSummary(result);
  }

  /**
   * Get the current configuration
   */
  getConfig(): SlapifyConfig {
    return this.config;
  }
}

export default Slapify;
