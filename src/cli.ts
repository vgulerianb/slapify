#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

import {
  loadConfig,
  loadCredentials,
  initConfig,
  getConfigDir,
} from "./config/loader.js";
import {
  parseFlowFile,
  findFlowFiles,
  validateFlowFile,
  getFlowSummary,
} from "./parser/flow.js";
import { TestRunner } from "./runner/index.js";
import { ReportGenerator } from "./report/generator.js";
import { BrowserAgent } from "./browser/agent.js";
import { TestResult } from "./types.js";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { LLMConfig, CredentialProfile } from "./types.js";
import yaml from "yaml";

// Load environment variables
dotenv.config();

/**
 * Get AI model based on config
 */
function getModelFromConfig(llmConfig: LLMConfig) {
  switch (llmConfig.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: llmConfig.api_key });
      return anthropic(llmConfig.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: llmConfig.api_key });
      return openai(llmConfig.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: llmConfig.api_key });
      return google(llmConfig.model);
    }
    case "mistral": {
      const mistral = createMistral({ apiKey: llmConfig.api_key });
      return mistral(llmConfig.model);
    }
    case "groq": {
      const groq = createGroq({ apiKey: llmConfig.api_key });
      return groq(llmConfig.model);
    }
    case "ollama": {
      const ollama = createOpenAI({
        apiKey: "ollama",
        baseURL: llmConfig.base_url || "http://localhost:11434/v1",
      });
      return ollama(llmConfig.model);
    }
    default:
      throw new Error(`Unsupported provider: ${llmConfig.provider}`);
  }
}

const program = new Command();

program
  .name("slapify")
  .description("AI-powered test automation using natural language flow files")
  .version("0.0.19", "-v, -V, --version");

// Init command
program
  .command("init")
  .description("Initialize Slapify in the current directory")
  .option("-y, --yes", "Skip prompts and use defaults")
  .action(async (options) => {
    const readline = await import("readline");

    // Check if already initialized
    if (fs.existsSync(".slapify")) {
      console.log(
        chalk.yellow("Slapify is already initialized in this directory.")
      );
      console.log(chalk.gray("Delete .slapify folder to reinitialize."));
      return;
    }

    console.log(chalk.blue.bold("\n🖐️  Welcome to Slapify!\n"));
    console.log(
      chalk.gray("AI-powered E2E testing that slaps - by slaps.dev\n")
    );

    // Import the new functions
    const { findSystemBrowsers, initConfig: doInit } = await import(
      "./config/loader.js"
    );

    let provider: LLMConfig["provider"] = "anthropic";
    let model: string | undefined;
    let browserPath: string | undefined;
    let useSystemBrowser: boolean | undefined;

    // Provider info with model options
    interface ModelOption {
      id: string;
      name: string;
      recommended?: boolean;
    }
    interface ProviderConfig {
      name: string;
      envVar: string;
      models?: ModelOption[];
      askModel?: boolean;
      defaultModel?: string;
    }

    const providerInfo: Record<string, ProviderConfig> = {
      anthropic: {
        name: "Anthropic (Claude)",
        envVar: "ANTHROPIC_API_KEY",
        defaultModel: "claude-sonnet-4-6",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Sonnet 4.6 (claude-sonnet-4-6) - highly capable & recommended",
            recommended: true,
          },
          {
            id: "claude-sonnet-4-5",
            name: "Sonnet 4.5 - fast & reliable",
          },
          {
            id: "claude-opus-4-6",
            name: "Opus 4.6 - extended reasoning & advanced tasks",
          },
          {
            id: "claude-3-7-sonnet-latest",
            name: "Sonnet 3.7 - legacy hybrid reasoning",
          },
          { id: "custom", name: "Enter custom model ID" },
        ],
      },
      openai: {
        name: "OpenAI",
        envVar: "OPENAI_API_KEY",
        defaultModel: "gpt-5.2",
        models: [
          {
            id: "gpt-5.2",
            name: "GPT-5.2 - latest flagship model",
            recommended: true,
          },
          { id: "o3-mini", name: "o3-mini - fast reasoning & coding" },
          { id: "gpt-5.3-codex", name: "GPT-5.3 Codex - advanced coding" },
          { id: "custom", name: "Enter custom model ID" },
        ],
      },
      google: {
        name: "Google (Gemini)",
        envVar: "GOOGLE_API_KEY",
        defaultModel: "gemini-3-flash",
        models: [
          {
            id: "gemini-3-flash",
            name: "Gemini 3 Flash - balanced & fast",
            recommended: true,
          },
          { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro - highly capable" },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash - older stable" },
          { id: "custom", name: "Enter custom model ID" },
        ],
      },
      mistral: {
        name: "Mistral",
        envVar: "MISTRAL_API_KEY",
        askModel: true,
        defaultModel: "mistral-small-latest",
      },
      groq: {
        name: "Groq (Fast inference)",
        envVar: "GROQ_API_KEY",
        askModel: true,
        defaultModel: "llama-3.3-70b-versatile",
      },
      ollama: {
        name: "Ollama (Local)",
        envVar: "",
        askModel: true,
        defaultModel: "llama3",
      },
    };

    if (options.yes) {
      // Use defaults
      console.log(chalk.gray("Using default settings...\n"));
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => rl.question(prompt, resolve));

      // Step 1: LLM Provider
      console.log(chalk.cyan("1. Choose your LLM provider:\n"));
      console.log("   1) Anthropic (Claude) " + chalk.green("- recommended"));
      console.log("   2) OpenAI (GPT-4)");
      console.log("   3) Google (Gemini)");
      console.log("   4) Mistral");
      console.log("   5) Groq " + chalk.gray("- fast & free tier"));
      console.log("   6) Ollama " + chalk.gray("- local, no API key"));
      console.log("");

      const providerChoice = await question(chalk.white("   Select [1]: "));
      const providerMap: Record<string, LLMConfig["provider"]> = {
        "1": "anthropic",
        "2": "openai",
        "3": "google",
        "4": "mistral",
        "5": "groq",
        "6": "ollama",
      };
      provider = providerMap[providerChoice] || "anthropic";

      const info = providerInfo[provider];
      console.log(chalk.green(`   ✓ Using ${info.name}\n`));

      // Step 1b: Model Selection
      if (info.models && info.models.length > 0) {
        console.log(chalk.cyan("   Choose model:\n"));
        info.models.forEach((m, i) => {
          const rec = m.recommended ? chalk.green(" ← recommended") : "";
          console.log(`   ${i + 1}) ${m.name}${rec}`);
        });
        console.log("");

        const modelChoice = await question(chalk.white("   Select [1]: "));
        const modelIdx = parseInt(modelChoice) - 1 || 0;
        const selectedModel = info.models[modelIdx];

        if (selectedModel?.id === "custom") {
          const customModel = await question(
            chalk.white("   Enter model ID: ")
          );
          model = customModel.trim() || info.defaultModel;
        } else {
          model = selectedModel?.id || info.defaultModel;
        }
        console.log(chalk.green(`   ✓ Using model: ${model}\n`));
      } else if (info.askModel) {
        // For Mistral, Groq, Ollama - ask for model ID directly
        console.log(
          chalk.gray(`   Enter model ID (default: ${info.defaultModel})`)
        );
        if (provider === "ollama") {
          console.log(
            chalk.gray("   Common models: llama3, mistral, codellama, phi3")
          );
        } else if (provider === "groq") {
          console.log(
            chalk.gray(
              "   Common models: llama-3.3-70b-versatile, mixtral-8x7b-32768"
            )
          );
        } else if (provider === "mistral") {
          console.log(
            chalk.gray(
              "   Common models: mistral-small-latest, mistral-large-latest"
            )
          );
        }
        console.log("");
        const modelInput = await question(
          chalk.white(`   Model [${info.defaultModel}]: `)
        );
        model = modelInput.trim() || info.defaultModel;
        console.log(chalk.green(`   ✓ Using model: ${model}\n`));

        if (provider === "ollama") {
          console.log(
            chalk.gray("   Make sure Ollama is running: ollama serve")
          );
          console.log("");
        }
      }

      // Step 2: API Key Verification (skip for Ollama)
      if (provider !== "ollama") {
        console.log(chalk.cyan("2. API Key verification:\n"));

        const envVar = info.envVar;
        let apiKey = process.env[envVar];

        if (apiKey) {
          console.log(chalk.gray(`   Found ${envVar} in environment`));
        } else {
          console.log(chalk.yellow(`   ${envVar} not found in environment`));
          console.log(
            chalk.gray(
              "   You can set it now or add it to your shell config later.\n"
            )
          );

          const keyInput = await question(
            chalk.white(`   Enter API key (or press Enter to skip): `)
          );
          if (keyInput.trim()) {
            apiKey = keyInput.trim();
          }
        }

        // API key verification loop
        let verified = false;
        while (!verified) {
          if (apiKey) {
            const verifyChoice = await question(
              chalk.white("   Verify API key with test call? (Y/n): ")
            );

            if (verifyChoice.toLowerCase() !== "n") {
              // Close readline temporarily - ora spinner can interfere with readline
              rl.pause();
              const verifySpinner = ora("   Verifying API key...").start();

              try {
                // Make a minimal test call
                const testConfig: LLMConfig = {
                  provider,
                  model: model || info.defaultModel || "test",
                  api_key: apiKey,
                };

                const testModel = getModelFromConfig(testConfig);
                const response = await generateText({
                  model: testModel as any,
                  prompt: "Reply with only the word 'pong'",
                  maxTokens: 10,
                });

                if (response.text.toLowerCase().includes("pong")) {
                  verifySpinner.succeed(chalk.green("API key verified! ✓"));
                } else {
                  verifySpinner.succeed(
                    chalk.green("API key works! (got response)")
                  );
                }
                verified = true;
              } catch (error: any) {
                verifySpinner.fail(chalk.red("API key verification failed"));
                console.log(chalk.red(`   Error: ${error.message}\n`));
              }
              // Resume readline after spinner is done
              rl.resume();

              if (!verified) {
                const retryChoice = await question(
                  chalk.white("   Try a different API key? (Y/n): ")
                );
                if (retryChoice.toLowerCase() === "n") {
                  console.log(
                    chalk.yellow(
                      `   Remember to set ${envVar} correctly before running tests.`
                    )
                  );
                  break;
                }
                const newKey = await question(
                  chalk.white(`   Enter API key: `)
                );
                if (newKey.trim()) {
                  apiKey = newKey.trim();
                } else {
                  console.log(chalk.yellow("   No key entered, skipping.\n"));
                  break;
                }
              }
            } else {
              console.log(chalk.gray("   Skipping verification\n"));
              break;
            }
          } else {
            console.log(
              chalk.yellow(
                `\n   Remember to set ${envVar} before running tests.`
              )
            );
            break;
          }
        }
        console.log("");
      }

      // Step 3: Browser Setup
      console.log(
        chalk.cyan(`${provider === "ollama" ? "2" : "3"}. Browser setup:\n`)
      );

      const systemBrowsers = findSystemBrowsers();

      if (systemBrowsers.length > 0) {
        console.log("   Found browsers on your system:");
        systemBrowsers.forEach((b, i) => {
          console.log(chalk.gray(`   ${i + 1}) ${b.name}`));
        });
        console.log(
          chalk.gray(
            `   ${systemBrowsers.length + 1}) Download Chromium (~170MB)`
          )
        );
        console.log(
          chalk.gray(`   ${systemBrowsers.length + 2}) Enter custom path`)
        );
        console.log("");

        const browserChoice = await question(chalk.white(`   Select [1]: `));
        const choiceNum = parseInt(browserChoice) || 1;

        if (choiceNum <= systemBrowsers.length) {
          browserPath = systemBrowsers[choiceNum - 1].path;
          useSystemBrowser = true;
          console.log(
            chalk.green(`   ✓ Using ${systemBrowsers[choiceNum - 1].name}\n`)
          );
        } else if (choiceNum === systemBrowsers.length + 2) {
          const customPath = await question(
            chalk.white("   Enter browser path: ")
          );
          if (customPath.trim()) {
            browserPath = customPath.trim();
            useSystemBrowser = true;
            console.log(chalk.green(`   ✓ Using custom browser\n`));
          }
        } else {
          useSystemBrowser = false;
          console.log(
            chalk.green("   ✓ Will download Chromium on first run\n")
          );
        }
      } else {
        console.log("   No browsers found. Options:");
        console.log(
          chalk.gray("   1) Download Chromium automatically (~170MB)")
        );
        console.log(chalk.gray("   2) Enter custom browser path"));
        console.log("");

        const browserChoice = await question(chalk.white("   Select [1]: "));

        if (browserChoice === "2") {
          const customPath = await question(
            chalk.white("   Enter browser path: ")
          );
          if (customPath.trim()) {
            browserPath = customPath.trim();
            useSystemBrowser = true;
            console.log(chalk.green("   ✓ Using custom browser\n"));
          }
        } else {
          useSystemBrowser = false;
          console.log(
            chalk.green("   ✓ Will download Chromium on first run\n")
          );
        }
      }

      rl.close();
    }

    // Initialize
    const spinner = ora("Creating configuration...").start();

    try {
      doInit(process.cwd(), {
        provider,
        model,
        browserPath,
        useSystemBrowser,
      });

      spinner.succeed("Slapify initialized!");

      console.log("");
      console.log(chalk.green("Created:"));
      console.log("  📁 .slapify/config.yaml      - Configuration");
      console.log("  🔐 .slapify/credentials.yaml - Credentials (gitignored)");
      console.log("  📝 tests/example.flow       - Sample test");
      console.log("");

      const info = providerInfo[provider];

      console.log(chalk.yellow("Next steps:"));
      console.log("");

      if (provider === "ollama") {
        console.log(chalk.white(`  1. Make sure Ollama is running:`));
        console.log(chalk.cyan(`     ollama serve`));
        console.log(chalk.cyan(`     ollama pull llama3`));
      } else {
        console.log(chalk.white(`  1. Set your API key:`));
        console.log(chalk.cyan(`     export ${info.envVar}=your-key-here`));
      }
      console.log("");
      console.log(chalk.white(`  2. Try an autonomous task:`));
      console.log(chalk.cyan(`     npx slapify task "Monitor Bitcoin price"`));
      console.log("");
      console.log(chalk.white(`  3. Run the example test flow:`));
      console.log(chalk.cyan(`     npx slapify run tests/example.flow`));
      console.log("");
      console.log(chalk.white(`  4. Create your own persistent tests:`));
      console.log(chalk.cyan(`     npx slapify create my-first-test`));
      console.log(
        chalk.cyan(`     npx slapify generate "test login for myapp.com"`)
      );
      console.log("");
      console.log(
        chalk.gray("  Config can be modified anytime in .slapify/config.yaml")
      );
      console.log("");
    } catch (error: any) {
      spinner.fail(error.message);
      process.exit(1);
    }
  });

// Install command (for agent-browser)
program
  .command("install")
  .description("Install browser dependencies")
  .action(() => {
    const spinner = ora("Checking agent-browser...").start();

    if (BrowserAgent.isInstalled()) {
      spinner.succeed("agent-browser is already installed");
    } else {
      spinner.text = "Installing agent-browser...";
      try {
        BrowserAgent.install();
        spinner.succeed("Browser dependencies installed!");
      } catch (error: any) {
        spinner.fail(`Installation failed: ${error.message}`);
        process.exit(1);
      }
    }
  });

// Run command
program
  .command("run [files...]")
  .description("Run flow test files")
  .option("--headed", "Run browser in headed mode (visible)")
  .option("--report [format]", "Generate report folder (html, markdown, json)")
  .option("--output <dir>", "Output directory for reports", "./test-reports")
  .option("--credentials <profile>", "Default credentials profile to use")
  .option("-p, --parallel", "Run tests in parallel")
  .option("-w, --workers <n>", "Number of parallel workers (default: 4)", "4")
  .option(
    "--performance",
    "Run performance audit (scores, real-user metrics, framework & re-render analysis) and include in report"
  )
  .action(async (files: string[], options) => {
    try {
      // Load configuration
      const configDir = getConfigDir();
      if (!configDir) {
        console.log(
          chalk.red('No .slapify directory found. Run "slapify init" first.')
        );
        process.exit(1);
      }

      const config = loadConfig(configDir);
      const credentials = loadCredentials(configDir);

      // Apply CLI options
      if (options.headed) {
        config.browser = { ...config.browser, headless: false };
      }

      // Only enable screenshots if report is requested
      const generateReport = options.report !== undefined;
      config.report = {
        ...config.report,
        format: typeof options.report === "string" ? options.report : "html",
        output_dir: options.output,
        screenshots: generateReport, // Only take screenshots for reports
      };

      // Find flow files
      let flowFiles: string[] = [];

      if (files.length === 0) {
        // Run all flow files in tests directory
        const testsDir = path.join(process.cwd(), "tests");
        if (fs.existsSync(testsDir)) {
          flowFiles = await findFlowFiles(testsDir);
        }
      } else {
        for (const file of files) {
          if (fs.statSync(file).isDirectory()) {
            const found = await findFlowFiles(file);
            flowFiles.push(...found);
          } else {
            flowFiles.push(file);
          }
        }
      }

      if (flowFiles.length === 0) {
        console.log(chalk.yellow("No .flow files found to run."));
        process.exit(0);
      }

      const reporter = new ReportGenerator(config.report);
      const results: TestResult[] = [];
      const isParallel = options.parallel && flowFiles.length > 1;
      const workers = parseInt(options.workers) || 4;

      if (isParallel) {
        // Parallel execution
        console.log(
          chalk.blue.bold(
            `\n━━━ Running ${flowFiles.length} tests in parallel (${workers} workers) ━━━\n`
          )
        );

        const pending = [...flowFiles];
        const running = new Map<string, Promise<void>>();
        const testStatus = new Map<string, string>();

        // Initialize status
        for (const file of flowFiles) {
          const name = path.basename(file, ".flow");
          testStatus.set(name, chalk.gray("⏳ pending"));
        }

        const printStatus = () => {
          // Clear and reprint status
          process.stdout.write("\x1B[" + flowFiles.length + "A"); // Move cursor up
          for (const file of flowFiles) {
            const name = path.basename(file, ".flow");
            const status = testStatus.get(name) || "";
            process.stdout.write("\x1B[2K"); // Clear line
            console.log(`  ${name}: ${status}`);
          }
        };

        // Print initial status
        for (const file of flowFiles) {
          const name = path.basename(file, ".flow");
          console.log(`  ${name}: ${testStatus.get(name)}`);
        }

        const runTest = async (file: string) => {
          const flow = parseFlowFile(file);
          const name = flow.name;
          testStatus.set(name, chalk.cyan("▶ running..."));
          printStatus();

          try {
            const runner = new TestRunner(config, credentials);
            const result = await runner.runFlow(flow);
            results.push(result);

            if (result.status === "passed") {
              testStatus.set(
                name,
                chalk.green(
                  `✓ passed (${result.passedSteps}/${result.totalSteps
                  } steps, ${(result.duration / 1000).toFixed(1)}s)`
                )
              );
            } else {
              testStatus.set(
                name,
                chalk.red(
                  `✗ failed (${result.failedSteps} failed, ${result.passedSteps} passed)`
                )
              );
            }
          } catch (error: any) {
            testStatus.set(name, chalk.red(`✗ error: ${error.message}`));
          }
          printStatus();
        };

        // Process with worker limit
        while (pending.length > 0 || running.size > 0) {
          // Start new tasks up to worker limit
          while (pending.length > 0 && running.size < workers) {
            const file = pending.shift()!;
            const promise = runTest(file).then(() => {
              running.delete(file);
            });
            running.set(file, promise);
          }

          // Wait for at least one to complete
          if (running.size > 0) {
            await Promise.race(running.values());
          }
        }

        console.log(""); // Extra newline after parallel run
      } else {
        // Sequential execution
        for (const file of flowFiles) {
          const flow = parseFlowFile(file);
          const summary = getFlowSummary(flow);

          // Print test header
          console.log("");
          console.log(chalk.blue.bold(`━━━ ${flow.name} ━━━`));
          console.log(
            chalk.gray(
              `    ${summary.totalSteps} steps (${summary.requiredSteps} required, ${summary.optionalSteps} optional)`
            )
          );
          console.log("");

          try {
            const runner = new TestRunner(config, credentials);
            const result = await runner.runFlow(
              flow,
              (stepResult) => {
                // Real-time step output
                const step = stepResult.step;
                const statusIcon =
                  stepResult.status === "passed"
                    ? chalk.green("✓")
                    : stepResult.status === "failed"
                      ? chalk.red("✗")
                      : chalk.yellow("⊘");
                const optionalTag = step.optional
                  ? chalk.gray(" [optional]")
                  : "";
                const retriedTag = stepResult.retried
                  ? chalk.yellow(" [retried]")
                  : "";
                const duration = chalk.gray(
                  `(${(stepResult.duration / 1000).toFixed(1)}s)`
                );

                console.log(
                  `  ${statusIcon} ${step.text}${optionalTag}${retriedTag} ${duration}`
                );

                // Show error inline if failed
                if (stepResult.status === "failed" && stepResult.error) {
                  console.log(chalk.red(`    └─ ${stepResult.error}`));
                }

                // Show assumptions if any
                if (
                  stepResult.assumptions &&
                  stepResult.assumptions.length > 0
                ) {
                  for (const assumption of stepResult.assumptions) {
                    console.log(chalk.gray(`    └─ 💡 ${assumption}`));
                  }
                }
              },
              !!options.performance
            );

            // Show perf summary inline if audit was run
            if (result.perfAudit) {
              const p = result.perfAudit;
              const parts: string[] = [];
              if (p.vitals.fcp) parts.push(`FCP ${p.vitals.fcp}ms`);
              if (p.vitals.lcp) parts.push(`LCP ${p.vitals.lcp}ms`);
              if (p.vitals.cls != null) parts.push(`CLS ${p.vitals.cls}`);
              const s = p.scores ?? p.lighthouse;
              if (s) parts.push(`Perf ${s.performance}/100`);
              console.log(chalk.cyan(`  ⚡ Perf: ${parts.join(" · ")}`));
            }

            results.push(result);

            // Print test summary
            console.log("");
            if (result.status === "passed") {
              console.log(
                chalk.green.bold(`  ✓ PASSED`) +
                chalk.gray(
                  ` (${result.passedSteps}/${result.totalSteps} steps in ${(
                    result.duration / 1000
                  ).toFixed(1)}s)`
                )
              );
            } else {
              console.log(
                chalk.red.bold(`  ✗ FAILED`) +
                chalk.gray(
                  ` (${result.failedSteps} failed, ${result.passedSteps} passed)`
                )
              );
            }

            // Auto-handled info
            if (result.autoHandled.length > 0) {
              console.log(
                chalk.gray(`  ℹ Auto-handled: ${result.autoHandled.join(", ")}`)
              );
            }
          } catch (error: any) {
            console.log(chalk.red(`  ✗ ERROR: ${error.message}`));
          }
        }
      }

      // Final summary
      console.log("");
      console.log(chalk.blue.bold("━━━ Summary ━━━"));
      const passed = results.filter((r) => r.status === "passed").length;
      const failed = results.filter((r) => r.status === "failed").length;
      const totalSteps = results.reduce((sum, r) => sum + r.totalSteps, 0);
      const passedSteps = results.reduce((sum, r) => sum + r.passedSteps, 0);

      console.log(
        chalk.gray(
          `  ${results.length} test file(s), ${totalSteps} total steps`
        )
      );

      if (failed === 0) {
        console.log(
          chalk.green.bold(
            `  ✓ All ${passed} test(s) passed! (${passedSteps}/${totalSteps} steps)`
          )
        );
      } else {
        console.log(
          chalk.red.bold(`  ✗ ${failed}/${results.length} test(s) failed`)
        );
      }

      // Generate suite report if requested and multiple files
      if (generateReport && results.length > 0) {
        let reportPath: string;
        if (results.length === 1) {
          reportPath = reporter.saveAsFolder(results[0]);
        } else {
          reportPath = reporter.saveSuiteAsFolder(results);
        }
        console.log(chalk.cyan(`\n  📄 Report: ${reportPath}`));
      }

      console.log("");

      if (failed > 0) {
        process.exit(1);
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Create command
program
  .command("create <name>")
  .description("Create a new flow file")
  .option("-d, --dir <directory>", "Directory to create flow in", "tests")
  .action(async (name: string, options) => {
    const readline = await import("readline");

    // Ensure directory exists
    const dir = options.dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Generate filename
    const filename = name.endsWith(".flow") ? name : `${name}.flow`;
    const filepath = path.join(dir, filename);

    if (fs.existsSync(filepath)) {
      console.log(chalk.red(`File already exists: ${filepath}`));
      process.exit(1);
    }

    console.log(chalk.blue(`\nCreating: ${filepath}`));
    console.log(
      chalk.gray(
        "Enter your test steps (one per line). Empty line to finish.\n"
      )
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const lines: string[] = [`# ${name}`, ""];
    let lineNum = 1;

    const askLine = (): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(chalk.cyan(`${lineNum}. `), (answer) => {
          resolve(answer);
        });
      });
    };

    while (true) {
      const line = await askLine();
      if (line === "") {
        break;
      }
      lines.push(line);
      lineNum++;
    }

    rl.close();

    if (lines.length <= 2) {
      console.log(chalk.yellow("\nNo steps entered. File not created."));
      return;
    }

    // Write file
    fs.writeFileSync(filepath, lines.join("\n") + "\n");
    console.log(chalk.green(`\n✓ Created: ${filepath}`));
    console.log(chalk.gray(`  ${lineNum - 1} steps`));
    console.log(chalk.gray(`\nRun with: slapify run ${filepath}`));
  });

// Generate command - AI-powered flow generation
program
  .command("generate <prompt>")
  .alias("gen")
  .description(
    "Generate a verified .flow file by running the goal as a task and recording what worked"
  )
  .option("-d, --dir <directory>", "Directory to save flow", "tests")
  .option("--headed", "Show browser window while running")
  .action(async (prompt: string, options) => {
    const configDir = getConfigDir();
    if (!configDir) {
      console.log(
        chalk.red('No .slapify directory found. Run "slapify init" first.')
      );
      process.exit(1);
    }

    const config = loadConfig(configDir);

    console.log(chalk.blue("\n🤖 Flow Generator\n"));
    console.log(
      chalk.gray(
        "  Running the goal in the browser to discover the real path...\n"
      )
    );

    // Delegate to the task agent with save-flow enabled.
    // The agent actually executes every step, handles login/captcha/popups,
    // and writes only steps that are proven to work.
    const { runTask } = await import("./task/runner.js");

    let savedPath: string | undefined;

    await runTask({
      goal: prompt,
      headed: options.headed,
      saveFlow: true,
      flowOutputDir: options.dir,
      onEvent: (event: any) => {
        if (event.type === "status_update") {
          process.stdout.write(chalk.gray(`  → ${event.message}\n`));
        }
        if (event.type === "message") {
          console.log(chalk.white(`\n${event.text}`));
        }
        if (event.type === "flow_saved") {
          savedPath = event.path;
        }
        if (event.type === "done") {
          console.log(chalk.green(`\n✅ Done`));
        }
        if (event.type === "error") {
          console.log(chalk.red(`\n✗ ${event.error}`));
        }
      },
    });

    if (savedPath) {
      console.log(chalk.green(`\n✓ Flow saved: ${savedPath}`));
      console.log(chalk.gray(`  Run with: slapify run ${savedPath}`));
    } else {
      console.log(
        chalk.yellow(
          "\n⚠ No flow was saved. The agent may not have completed the goal."
        )
      );
    }
  });

// Fix command - analyze and fix failing tests
program
  .command("fix <file>")
  .description("Analyze a failing test and suggest/apply fixes")
  .option("--auto", "Automatically apply suggested fixes without confirmation")
  .option("--headed", "Run browser in headed mode for debugging")
  .action(async (file: string, options) => {
    const configDir = getConfigDir();
    if (!configDir) {
      console.log(
        chalk.red('No .slapify directory found. Run "slapify init" first.')
      );
      process.exit(1);
    }

    if (!fs.existsSync(file)) {
      console.log(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    const config = loadConfig(configDir);
    const credentials = loadCredentials(configDir);

    if (options.headed) {
      config.browser = { ...config.browser, headless: false };
    }

    // Enable screenshots for diagnosis
    config.report = { ...config.report, screenshots: true };

    const readline = await import("readline");
    let spinner = ora("Running test to identify failures...").start();

    try {
      // Step 1: Run the test to see what fails
      const flow = parseFlowFile(file);
      const runner = new TestRunner(config, credentials);

      const failedSteps: Array<{
        step: string;
        error: string;
        line: number;
        screenshot?: string;
      }> = [];

      const result = await runner.runFlow(flow, (stepResult) => {
        if (stepResult.status === "failed" && stepResult.error) {
          failedSteps.push({
            step: stepResult.step.text,
            error: stepResult.error,
            line: stepResult.step.line,
            screenshot: stepResult.screenshot,
          });
        }
      });

      if (result.status === "passed") {
        spinner.succeed("Test passed! No fixes needed.");
        return;
      }

      spinner.info(`Found ${failedSteps.length} failing step(s)`);

      if (failedSteps.length === 0) {
        console.log(chalk.yellow("No specific step failures to fix."));
        return;
      }

      // Step 2: Read the original flow file
      const originalContent = fs.readFileSync(file, "utf-8");
      const lines = originalContent.split("\n");

      // Step 3: Use AI to analyze and suggest fixes
      spinner = ora("Analyzing failures and generating fixes...").start();

      const failureDetails = failedSteps
        .map((f) => `Line ${f.line}: "${f.step}"\n  Error: ${f.error}`)
        .join("\n\n");

      const analysisResponse = await generateText({
        model: getModelFromConfig(config.llm) as any,
        system: `You are a test automation expert. Analyze failing test steps and suggest fixes.

Original flow file:
\`\`\`
${originalContent}
\`\`\`

Failing steps:
${failureDetails}

Based on the errors, suggest fixes for the flow file. Common issues and fixes:
1. Element not found → Try more descriptive text, add wait, or make step optional
2. Timeout → Add explicit wait or increase timeout
3. Navigation error → Add wait after navigation, or split into smaller steps
4. Element obscured → Add step to close popup/modal first
5. Stale element → Add wait for page to stabilize

Respond with JSON:
{
  "analysis": "Brief explanation of what's wrong",
  "fixes": [
    {
      "line": 5,
      "original": "Click the submit button",
      "fixed": "Click the Submit button",
      "reason": "Button text is capitalized"
    }
  ],
  "additions": [
    {
      "afterLine": 4,
      "step": "[Optional] Wait for page to load",
      "reason": "Page might still be loading"
    }
  ]
}`,
        prompt: "Analyze the failures and suggest specific fixes.",
        maxTokens: 1500,
      });

      spinner.succeed("Analysis complete");

      // Parse the response
      const jsonMatch = analysisResponse.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(chalk.red("Could not parse AI response"));
        return;
      }

      const suggestions = JSON.parse(jsonMatch[0]);

      // Step 4: Display suggestions
      console.log(chalk.blue("\n━━━ Analysis ━━━\n"));
      console.log(chalk.white(suggestions.analysis));

      if (suggestions.fixes?.length > 0 || suggestions.additions?.length > 0) {
        console.log(chalk.blue("\n━━━ Suggested Fixes ━━━\n"));

        if (suggestions.fixes?.length > 0) {
          for (const fix of suggestions.fixes) {
            console.log(chalk.yellow(`Line ${fix.line}:`));
            console.log(chalk.red(`  - ${fix.original}`));
            console.log(chalk.green(`  + ${fix.fixed}`));
            console.log(chalk.gray(`  Reason: ${fix.reason}\n`));
          }
        }

        if (suggestions.additions?.length > 0) {
          console.log(chalk.yellow("New steps to add:"));
          for (const add of suggestions.additions) {
            console.log(
              chalk.green(`  + After line ${add.afterLine}: ${add.step}`)
            );
            console.log(chalk.gray(`    Reason: ${add.reason}\n`));
          }
        }

        // Step 5: Apply fixes
        let shouldApply = options.auto;

        if (!shouldApply) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.cyan("Apply these fixes? (y/N): "), (answer) => {
              rl.close();
              resolve(answer.trim().toLowerCase());
            });
          });

          shouldApply = answer === "y" || answer === "yes";
        }

        if (shouldApply) {
          // Apply fixes to lines
          let newLines = [...lines];
          const lineOffsets = new Map<number, number>(); // Track line number changes

          // Apply modifications first
          if (suggestions.fixes) {
            for (const fix of suggestions.fixes) {
              const lineIdx = fix.line - 1;
              if (lineIdx >= 0 && lineIdx < newLines.length) {
                newLines[lineIdx] = fix.fixed;
              }
            }
          }

          // Apply additions (in reverse order to maintain line numbers)
          if (suggestions.additions) {
            const sortedAdditions = [...suggestions.additions].sort(
              (a, b) => b.afterLine - a.afterLine
            );
            for (const add of sortedAdditions) {
              const afterIdx = add.afterLine;
              newLines.splice(afterIdx, 0, add.step);
            }
          }

          // Write the fixed file
          const newContent = newLines.join("\n");

          // Backup original
          const backupPath = file + ".backup";
          fs.writeFileSync(backupPath, originalContent);

          // Write fixed version
          fs.writeFileSync(file, newContent);

          console.log(chalk.green(`\n✓ Fixes applied to ${file}`));
          console.log(chalk.gray(`  Backup saved to ${backupPath}`));
          console.log(chalk.gray(`\nRun again with: slapify run ${file}`));
        } else {
          console.log(chalk.yellow("No changes made."));
        }
      } else {
        console.log(chalk.yellow("\nNo automatic fixes suggested."));
        console.log(
          chalk.gray("The failures may require manual investigation.")
        );
      }
    } catch (error: any) {
      spinner.fail("Error");
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Validate command
program
  .command("validate [files...]")
  .description("Validate flow files for syntax issues")
  .action(async (files: string[]) => {
    let flowFiles: string[] = [];

    if (files.length === 0) {
      const testsDir = path.join(process.cwd(), "tests");
      if (fs.existsSync(testsDir)) {
        flowFiles = await findFlowFiles(testsDir);
      }
    } else {
      flowFiles = files;
    }

    if (flowFiles.length === 0) {
      console.log(chalk.yellow("No .flow files found."));
      return;
    }

    let hasWarnings = false;

    for (const file of flowFiles) {
      try {
        const flow = parseFlowFile(file);
        const warnings = validateFlowFile(flow);
        const summary = getFlowSummary(flow);

        if (warnings.length > 0) {
          hasWarnings = true;
          console.log(chalk.yellow(`⚠️  ${file}`));
          for (const warning of warnings) {
            console.log(chalk.yellow(`   ${warning}`));
          }
        } else {
          console.log(chalk.green(`✅ ${file}`));
          console.log(
            chalk.gray(
              `   ${summary.totalSteps} steps (${summary.requiredSteps} required, ${summary.optionalSteps} optional)`
            )
          );
        }
      } catch (error: any) {
        console.log(chalk.red(`❌ ${file}`));
        console.log(chalk.red(`   ${error.message}`));
        hasWarnings = true;
      }
    }

    if (hasWarnings) {
      process.exit(1);
    }
  });

// List command
program
  .command("list")
  .description("List all flow files")
  .action(async () => {
    const testsDir = path.join(process.cwd(), "tests");

    if (!fs.existsSync(testsDir)) {
      console.log(chalk.yellow("No tests directory found."));
      return;
    }

    const flowFiles = await findFlowFiles(testsDir);

    if (flowFiles.length === 0) {
      console.log(chalk.yellow("No .flow files found."));
      return;
    }

    console.log(chalk.blue(`\nFound ${flowFiles.length} flow file(s):\n`));

    for (const file of flowFiles) {
      const flow = parseFlowFile(file);
      const summary = getFlowSummary(flow);
      const relativePath = path.relative(process.cwd(), file);

      console.log(`  ${chalk.white(relativePath)}`);
      console.log(
        chalk.gray(
          `    ${summary.totalSteps} steps (${summary.requiredSteps} required, ${summary.optionalSteps} optional)`
        )
      );
    }

    console.log("");
  });

// Credentials command
program
  .command("credentials")
  .description("List configured credential profiles")
  .action(() => {
    const configDir = getConfigDir();

    if (!configDir) {
      console.log(
        chalk.red('No .slapify directory found. Run "slapify init" first.')
      );
      process.exit(1);
    }

    const credentials = loadCredentials(configDir);
    const profiles = Object.keys(credentials.profiles);

    if (profiles.length === 0) {
      console.log(chalk.yellow("No credential profiles configured."));
      console.log(
        chalk.gray("Edit .slapify/credentials.yaml to add profiles.")
      );
      return;
    }

    console.log(chalk.blue(`\nConfigured credential profiles:\n`));

    for (const name of profiles) {
      const profile = credentials.profiles[name];
      console.log(`  ${chalk.white(name)} (${profile.type})`);

      if (profile.username) {
        console.log(chalk.gray(`    username: ${profile.username}`));
      }
      if (profile.email) {
        console.log(chalk.gray(`    email: ${profile.email}`));
      }
      if (profile.totp_secret) {
        console.log(chalk.gray(`    2FA: TOTP configured`));
      }
      if (profile.fixed_otp) {
        console.log(chalk.gray(`    2FA: Fixed OTP configured`));
      }
    }

    console.log("");
  });

// Fix credentials YAML (localStorage/sessionStorage saved as JSON strings)
function normalizeStorage(v: unknown): Record<string, string> {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    out[String(k)] = typeof val === "string" ? val : JSON.stringify(val);
  }
  return out;
}

function fixCredentialsFile(filePath: string, dryRun: boolean): boolean {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.log(chalk.yellow(`  Skip (not found): ${resolved}`));
    return false;
  }
  const content = fs.readFileSync(resolved, "utf-8");
  let data: { profiles?: Record<string, CredentialProfile> };
  try {
    data = yaml.parse(content);
  } catch (e: any) {
    console.log(chalk.red(`  Invalid YAML: ${resolved}`));
    console.log(chalk.gray(`  ${e.message}`));
    return false;
  }
  if (!data || !data.profiles || typeof data.profiles !== "object") {
    console.log(chalk.yellow(`  No profiles in: ${resolved}`));
    return false;
  }
  let changed = false;
  for (const [name, profile] of Object.entries(data.profiles)) {
    if (profile.type !== "inject") continue;
    const needLocal =
      typeof profile.localStorage === "string" ||
      (profile.localStorage &&
        (Array.isArray(profile.localStorage) ||
          typeof profile.localStorage !== "object"));
    const needSession =
      typeof profile.sessionStorage === "string" ||
      (profile.sessionStorage &&
        (Array.isArray(profile.sessionStorage) ||
          typeof profile.sessionStorage !== "object"));
    if (!needLocal && !needSession) continue;
    data.profiles[name] = {
      ...profile,
      ...(needLocal && {
        localStorage: normalizeStorage(profile.localStorage),
      }),
      ...(needSession && {
        sessionStorage: normalizeStorage(profile.sessionStorage),
      }),
    };
    changed = true;
  }
  if (!changed) {
    console.log(chalk.gray(`  No changes needed: ${resolved}`));
    return false;
  }
  if (dryRun) {
    console.log(chalk.cyan(`  Would fix: ${resolved}`));
    return true;
  }
  const backupPath = resolved + ".backup";
  fs.copyFileSync(resolved, backupPath);
  fs.writeFileSync(resolved, yaml.stringify(data, { indent: 2, lineWidth: 0 }));
  console.log(chalk.green(`  Fixed: ${resolved}`));
  console.log(chalk.gray(`  Backup: ${backupPath}`));
  return true;
}

program
  .command("fix-credentials [files...]")
  .description(
    "Fix credential YAML files where localStorage/sessionStorage were saved as JSON strings"
  )
  .option("--dry-run", "Only print what would be fixed")
  .action((files: string[] | undefined, options: { dryRun?: boolean }) => {
    const toFix: string[] = [];
    if (files && files.length > 0) {
      toFix.push(...files.map((f) => path.resolve(f)));
    } else {
      const cwd = process.cwd();
      toFix.push(path.join(cwd, "temp_credentials.yaml"));
      const configDir = getConfigDir();
      if (configDir) {
        toFix.push(path.join(configDir, "credentials.yaml"));
      }
    }
    console.log(chalk.blue("\n🔧 Fix credential YAML files\n"));
    if (options.dryRun) {
      console.log(chalk.gray("  (dry run – no files will be modified)\n"));
    }
    let fixed = 0;
    for (const f of toFix) {
      if (fixCredentialsFile(f, !!options.dryRun)) fixed++;
    }
    if (fixed === 0 && toFix.length > 0) {
      console.log(chalk.gray("\n  No files needed fixing."));
    }
    console.log("");
  });

// Interactive mode
program
  .command("interactive [url]")
  .alias("i")
  .description("Run steps interactively")
  .option("--headed", "Run browser in headed mode")
  .action(async (url: string | undefined, options) => {
    console.log(chalk.blue("\n🧪 Slapify Interactive Mode"));
    console.log(
      chalk.gray(
        'Type test steps and press Enter to execute. Type "exit" to quit.\n'
      )
    );

    const configDir = getConfigDir();
    if (!configDir) {
      console.log(
        chalk.red('No .slapify directory found. Run "slapify init" first.')
      );
      process.exit(1);
    }

    const config = loadConfig(configDir);
    const credentials = loadCredentials(configDir);

    if (options.headed) {
      config.browser = { ...config.browser, headless: false };
    }

    const runner = new TestRunner(config, credentials);

    if (url) {
      console.log(chalk.gray(`Navigating to ${url}...`));
      // Would navigate here
    }

    // Simple readline interface
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question(chalk.cyan("> "), async (input) => {
        const trimmed = input.trim();

        if (
          trimmed.toLowerCase() === "exit" ||
          trimmed.toLowerCase() === "quit"
        ) {
          console.log(chalk.gray("\nGoodbye!"));
          rl.close();
          process.exit(0);
        }

        if (!trimmed) {
          prompt();
          return;
        }

        // Execute the step
        console.log(chalk.gray(`Executing: ${trimmed}`));
        // Would execute step here
        console.log(chalk.green("✓ Done"));

        prompt();
      });
    };

    prompt();
  });

// ─── Task command ─────────────────────────────────────────────────────────────

program
  .command("task [goal]")
  .description(
    "Run an autonomous AI agent task in plain English.\n" +
    "  The agent decides everything: what to do, when to schedule, when to sleep.\n" +
    "  Examples:\n" +
    '    slapify task "Go to linkedin.com and like the latest 3 posts"\n' +
    '    slapify task "Monitor my Gmail for new emails every 30 min and log subjects"\n' +
    '    slapify task "Order breakfast from Swiggy every day at 8am"'
  )
  .option("--headed", "Show the browser window")
  .option("--debug", "Show all tool calls and internal steps")
  .option("--report", "Generate an HTML report after the task completes")
  .option("--save-flow", "Save agent steps as a reusable .flow file when done")
  .option("--session <id>", "Resume an existing task session")
  .option("--list-sessions", "List all task sessions")
  .option("--logs <id>", "Show logs for a task session")
  .option(
    "--max-iterations <n>",
    "Safety cap on agent loop iterations (default 400)",
    parseInt
  )
  .option(
    "--schema <json-or-file>",
    "JSON Schema (inline JSON string or path to a .json file) the agent should use to structure its output"
  )
  .option(
    "--output <file>",
    "File path to write structured JSON output to (used together with --schema)"
  )
  .action(async (goal: string | undefined, options) => {
    // Sub-command: list sessions
    if (options.listSessions) {
      const { listSessions } = await import("./task/index.js");
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log(chalk.gray("\nNo task sessions found.\n"));
        return;
      }
      console.log(chalk.blue(`\n📋 Task Sessions (${sessions.length})\n`));
      for (const s of sessions) {
        const statusColor =
          s.status === "completed"
            ? chalk.green
            : s.status === "failed"
              ? chalk.red
              : s.status === "scheduled"
                ? chalk.blue
                : chalk.yellow;
        console.log(
          `  ${statusColor("●")} ${chalk.bold(s.id)}\n` +
          `    Goal: ${s.goal.slice(0, 70)}${s.goal.length > 70 ? "…" : ""
          }\n` +
          `    Status: ${statusColor(s.status)}  Iterations: ${s.iteration
          }\n` +
          `    Updated: ${new Date(s.updatedAt).toLocaleString()}\n`
        );
      }
      return;
    }

    // Sub-command: show logs
    if (options.logs) {
      const { loadSession } = await import("./task/index.js");
      const { loadEvents } = await import("./task/session.js");
      const session = loadSession(options.logs);
      if (!session) {
        console.log(chalk.red(`Session '${options.logs}' not found.`));
        process.exit(1);
      }
      console.log(chalk.blue(`\n📜 Logs: ${session.id}\n`));
      console.log(chalk.gray(`Goal: ${session.goal}\n`));
      const events = loadEvents(options.logs);
      for (const event of events) {
        const ts = chalk.gray(new Date(event.ts).toLocaleTimeString());
        if (event.type === "llm_response") {
          if (event.text)
            console.log(`${ts} 🤔 ${chalk.cyan(event.text.slice(0, 120))}`);
        } else if (event.type === "tool_call") {
          console.log(
            `${ts} 🔧 ${chalk.yellow(event.toolName)} → ${chalk.gray(
              JSON.stringify(event.result).slice(0, 80)
            )}`
          );
        } else if (event.type === "tool_error") {
          console.log(
            `${ts} ❌ ${chalk.red(event.toolName)} → ${chalk.red(
              event.error.slice(0, 80)
            )}`
          );
        } else if (event.type === "memory_update") {
          console.log(
            `${ts} 🧠 ${chalk.magenta("remember")} ${event.key
            } = ${event.value.slice(0, 60)}`
          );
        } else if (event.type === "scheduled") {
          console.log(
            `${ts} ⏰ ${chalk.blue("schedule")} ${event.cron} — ${event.task}`
          );
        } else if (event.type === "sleeping_until") {
          console.log(`${ts} 😴 ${chalk.blue("sleep")} until ${event.until}`);
        } else if (event.type === "session_end") {
          console.log(
            `${ts} ✅ ${chalk.green("done")} ${event.summary.slice(0, 120)}`
          );
        }
      }
      console.log("");
      return;
    }

    // Determine goal
    let taskGoal = goal || options.session ? goal : undefined;

    // Resume without goal is fine — goal is stored in session
    if (!taskGoal && !options.session) {
      console.log(
        chalk.red(
          '\nPlease provide a goal. Example:\n  slapify task "Go to example.com and check the title"\n'
        )
      );
      process.exit(1);
    }

    // If resuming, load the goal from session
    if (!taskGoal && options.session) {
      const { loadSession } = await import("./task/index.js");
      const s = loadSession(options.session);
      if (!s) {
        console.log(chalk.red(`Session '${options.session}' not found.`));
        process.exit(1);
      }
      taskGoal = s.goal;
    }

    // Check config
    const configDir = getConfigDir();
    if (!configDir) {
      console.log(
        chalk.red('\nNo .slapify directory found. Run "slapify init" first.\n')
      );
      process.exit(1);
    }

    // Track current session so SIGINT can generate report
    let activeSession: import("./task/types.js").TaskSession | null = null;

    const generateAndPrintReport = async (
      session: import("./task/types.js").TaskSession
    ) => {
      if (!options.report) return;
      try {
        const { loadEvents, saveTaskReport } = await import("./task/index.js");
        const events = loadEvents(session.id);
        const reportPath = saveTaskReport(session, events);
        console.log(chalk.cyan(`\n  📊 Report: ${reportPath}`));
      } catch (e: any) {
        console.log(
          chalk.yellow(`  ⚠ Could not generate report: ${e?.message}`)
        );
      }
    };

    const debug = !!options.debug;

    // Clear the "thinking..." spinner line
    const clearLine = () => process.stdout.write("\x1b[2K\r");

    const printEvent = (event: import("./task/types.js").TaskEvent) => {
      switch (event.type) {
        // ── Debug-only (verbose internal steps) ───────────────────────────
        case "thinking":
          if (debug) process.stdout.write(chalk.gray("  ⟳ thinking...\r"));
          break;

        case "message":
          if (debug) {
            clearLine();
            console.log(chalk.gray(`  💬 ${event.text}`));
          }
          break;

        case "tool_start":
          if (debug) {
            clearLine();
            const argStr = JSON.stringify(event.args);
            console.log(
              chalk.dim(`  › ${chalk.cyan(event.toolName)} `) +
              chalk.gray(
                argStr.slice(0, 100) + (argStr.length > 100 ? "…" : "")
              )
            );
          }
          break;

        case "tool_done":
          if (debug) {
            console.log(chalk.dim(`    ✓ ${event.result.slice(0, 120)}`));
          }
          break;

        case "tool_error":
          // Always show errors
          clearLine();
          console.log(
            chalk.red(`  ✗ ${event.toolName}: ${event.error.slice(0, 120)}`)
          );
          break;

        // ── Always visible ────────────────────────────────────────────────
        case "status_update":
          clearLine();
          console.log(chalk.white(`  ${event.message}`));
          break;

        case "human_input_needed":
          // spinner is stopped by the trigger check above
          console.log("\n" + chalk.yellow("─".repeat(60)));
          console.log(chalk.yellow.bold("  🙋 Agent needs your input"));
          console.log(chalk.white(`\n  ${event.question}`));
          if (event.hint) console.log(chalk.gray(`  ${event.hint}`));
          // Answer is handled via onHumanInput callback — just show the prompt here
          break;

        case "credentials_saved":
          clearLine();
          console.log(
            chalk.green(
              `  💾 Credentials saved: '${event.profileName}' (${event.credType}) → .slapify/credentials.yaml`
            )
          );
          break;

        case "scheduled":
          if (debug) {
            clearLine();
            console.log(
              chalk.dim(`  ⏰ scheduled: ${event.cron} — ${event.task}`)
            );
          }
          break;

        case "sleeping":
          if (debug) {
            clearLine();
            console.log(
              chalk.dim(
                `  😴 sleeping until ${new Date(event.until).toLocaleString()}`
              )
            );
          }
          break;

        case "done":
          clearLine();
          console.log("\n" + chalk.green("─".repeat(60)));
          console.log(chalk.green.bold("  ✅ Task complete!"));
          console.log(chalk.white(`\n  ${event.summary}`));
          console.log(chalk.green("─".repeat(60)));
          break;

        case "error":
          clearLine();
          console.log(chalk.red(`\n  ✗ Error: ${event.error}`));
          break;
      }
    };

    console.log(chalk.blue("\n🤖 Slapify Task Agent\n"));
    console.log(chalk.white(`  Goal: ${taskGoal}`));
    if (options.session)
      console.log(chalk.gray(`  Resuming session: ${options.session}`));
    console.log(
      chalk.gray(
        [
          options.report ? "  --report: HTML report on exit" : "",
          debug ? "  --debug: verbose output" : "",
          "  Ctrl+C to stop",
        ]
          .filter(Boolean)
          .join("  ·  ") + "\n"
      )
    );
    console.log(chalk.gray("─".repeat(60)) + "\n");

    // Thinking spinner for default (non-debug) mode
    let spinnerInterval: ReturnType<typeof setInterval> | null = null;
    let spinnerPaused = false; // true while waiting for human input

    const startSpinner = () => {
      if (debug || spinnerPaused || spinnerInterval) return;
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let fi = 0;
      spinnerInterval = setInterval(() => {
        process.stdout.write(
          chalk.gray(`\r  ${frames[fi++ % frames.length]} working...`)
        );
      }, 80);
    };

    if (!debug) startSpinner();

    const { runTask } = await import("./task/index.js");

    // SIGINT handler — generate report then exit gracefully
    let sigintHandled = false;
    const onSigint = async () => {
      if (sigintHandled) return;
      sigintHandled = true;
      clearInterval(spinnerInterval!);
      spinnerInterval = null;
      spinnerPaused = true;
      process.stdout.write("\x1b[2K\r");
      console.log(
        chalk.yellow(
          "\n  ⚡ Interrupted" +
          (options.report ? " — generating report..." : "")
        )
      );
      if (activeSession) {
        activeSession.status = "failed";
        activeSession.finalSummary = "Task interrupted by user (Ctrl+C).";
        const { saveSessionMeta } = await import("./task/session.js");
        saveSessionMeta(activeSession);
        await generateAndPrintReport(activeSession);
      }
      console.log(chalk.gray("  Goodbye.\n"));
      process.exit(0);
    };
    process.once("SIGINT", onSigint);

    try {
      const stopSpinner = () => {
        if (spinnerInterval) {
          clearInterval(spinnerInterval);
          spinnerInterval = null;
        }
        process.stdout.write("\x1b[2K\r");
      };

      // Parse --schema (inline JSON or path to .json file)
      let parsedSchema: Record<string, unknown> | undefined;
      if (options.schema) {
        try {
          // Try inline JSON first
          parsedSchema = JSON.parse(options.schema);
        } catch {
          // Fall back to file path
          try {
            const schemaRaw = fs.readFileSync(
              path.resolve(options.schema),
              "utf8"
            );
            parsedSchema = JSON.parse(schemaRaw);
          } catch {
            console.log(
              chalk.red(
                `Could not parse --schema: expected inline JSON or a valid .json file path.`
              )
            );
            process.exit(1);
          }
        }
      }

      const session = await runTask({
        goal: taskGoal!,
        sessionId: options.session,
        headed: options.headed,
        saveFlow: options.saveFlow,
        maxIterations: options.maxIterations,
        schema: parsedSchema,
        outputFile: options.output,
        onHumanInput: async (question, hint) => {
          // Spinner is already stopped; block it from restarting while we read input
          spinnerPaused = true;
          stopSpinner();

          // Read a full line from stdin cleanly
          const readline = await import("readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
          });
          const answer = await new Promise<string>((resolve) => {
            rl.question(`  ${chalk.cyan("›")} `, (ans) => {
              rl.close();
              resolve(ans.trim());
            });
          });

          console.log(chalk.yellow("─".repeat(60)) + "\n");

          // Unblock and restart spinner
          spinnerPaused = false;
          startSpinner();

          return answer;
        },
        onEvent: (event) => {
          const isVisible =
            event.type === "status_update" ||
            event.type === "human_input_needed" ||
            event.type === "credentials_saved" ||
            event.type === "done" ||
            event.type === "error" ||
            event.type === "tool_error";

          if (isVisible) stopSpinner();
          printEvent(event);
          // Restart spinner after visible output (but not if waiting for input or finished)
          if (
            isVisible &&
            event.type !== "done" &&
            event.type !== "error" &&
            event.type !== "human_input_needed" // onHumanInput restarts it after input
          ) {
            startSpinner();
          }
        },
        onSessionUpdate: (s) => {
          activeSession = s;
        },
      });
      stopSpinner();

      process.removeListener("SIGINT", onSigint);

      console.log(chalk.gray(`\n  Session: ${session.id}`));
      if (session.savedFlowPath) {
        console.log(chalk.cyan(`  Flow saved: ${session.savedFlowPath}`));
      }
      if (options.output && session.structuredOutput != null) {
        console.log(
          chalk.cyan(`  Output:     ${path.resolve(options.output)}`)
        );
      }
      if (Object.keys(session.memory).length > 0) {
        console.log(
          chalk.gray(`  Memory (${Object.keys(session.memory).length} items):`)
        );
        for (const [k, v] of Object.entries(session.memory)) {
          console.log(chalk.gray(`    • ${k}: ${v.slice(0, 80)}`));
        }
      }

      // Always generate report after task completes
      await generateAndPrintReport(session);
      console.log("");
    } catch (err: any) {
      process.removeListener("SIGINT", onSigint);
      clearInterval(spinnerInterval!);
      spinnerInterval = null;
      process.stdout.write("\x1b[2K\r");
      console.error(chalk.red(`\n  Task failed: ${err?.message || err}`));
      if (activeSession) {
        await generateAndPrintReport(activeSession);
      }
      process.exit(1);
    }
  });

program.parse();
