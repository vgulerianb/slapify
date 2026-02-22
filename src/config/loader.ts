import fs from "fs";
import path from "path";
import yaml from "yaml";
import { SlapifyConfig, CredentialsConfig } from "../types.js";

const CONFIG_DIR = ".slapify";
const CONFIG_FILE = "config.yaml";
const CREDENTIALS_FILE = "credentials.yaml";

/**
 * Find the config directory by walking up from cwd
 */
function findConfigDir(startDir: string = process.cwd()): string | null {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    const configPath = path.join(currentDir, CONFIG_DIR);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Replace environment variables in string values
 */
function replaceEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || "");
  }
  if (Array.isArray(obj)) {
    return obj.map(replaceEnvVars);
  }
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceEnvVars(value);
    }
    return result;
  }
  return obj;
}

/**
 * Load and parse the main config file
 */
export function loadConfig(configDir?: string): SlapifyConfig {
  const dir = configDir || findConfigDir();

  if (!dir) {
    throw new Error(
      'No .slapify directory found. Run "slapify init" to create one.'
    );
  }

  const configPath = path.join(dir, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = yaml.parse(content) as SlapifyConfig;

  // Replace environment variables
  const resolved = replaceEnvVars(config) as SlapifyConfig;

  // Apply defaults
  return {
    ...resolved,
    browser: {
      headless: true,
      timeout: 30000,
      viewport: { width: 1280, height: 720 },
      ...resolved.browser,
    },
    report: {
      format: "markdown",
      screenshots: true,
      output_dir: "./test-reports",
      ...resolved.report,
    },
  };
}

/**
 * Load and parse the credentials file
 */
export function loadCredentials(configDir?: string): CredentialsConfig {
  const dir = configDir || findConfigDir();

  if (!dir) {
    return { profiles: {} };
  }

  const credentialsPath = path.join(dir, CREDENTIALS_FILE);

  if (!fs.existsSync(credentialsPath)) {
    return { profiles: {} };
  }

  const content = fs.readFileSync(credentialsPath, "utf-8");
  const credentials = yaml.parse(content) as CredentialsConfig;

  // Replace environment variables
  return replaceEnvVars(credentials) as CredentialsConfig;
}

export interface InitOptions {
  provider?: "anthropic" | "openai" | "google" | "mistral" | "groq" | "ollama";
  model?: string;
  browserPath?: string;
  useSystemBrowser?: boolean;
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6", // Highly capable & recommended
  openai: "gpt-5.2", // Latest flagship
  google: "gemini-3-flash", // Balanced & fast
  mistral: "mistral-small-latest", // Cheap
  groq: "llama-3.3-70b-versatile", // Free tier
  ollama: "llama3", // Local
};

const ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  ollama: "",
};

/**
 * Initialize a new .slapify directory with default config
 */
export function initConfig(
  targetDir: string = process.cwd(),
  options: InitOptions = {}
): void {
  const configDir = path.join(targetDir, CONFIG_DIR);

  if (fs.existsSync(configDir)) {
    throw new Error(".slapify directory already exists");
  }

  fs.mkdirSync(configDir, { recursive: true });

  // Determine LLM settings
  const provider = options.provider || "anthropic";
  const model = options.model || DEFAULT_MODELS[provider];
  const envVar = ENV_VARS[provider];

  // Build browser config
  let browserConfig = `browser:
  headless: true
  timeout: 30000
  viewport:
    width: 1280
    height: 720`;

  if (options.browserPath) {
    browserConfig += `
  # Using system browser (saves ~170MB download)
  executablePath: "${options.browserPath}"`;
  } else if (options.useSystemBrowser === false) {
    browserConfig += `
  # Will download Chromium on first run (~170MB)`;
  }

  // Build LLM config section
  let llmConfig = `llm:
  provider: ${provider}
  model: ${model}`;

  if (provider === "ollama") {
    llmConfig += `
  # Ollama runs locally - no API key needed
  base_url: http://localhost:11434/v1`;
  } else {
    llmConfig += `
  api_key: \${${envVar}}`;
  }

  // Create config.yaml
  const configContent = `# Slapify Configuration
# Docs: https://slaps.dev/slapify

# LLM Settings (required)
# You can change the provider and model anytime
${llmConfig}

# Browser Settings
${browserConfig}

# Report Settings
report:
  format: html
  screenshots: true
  output_dir: ./test-reports
`;

  fs.writeFileSync(path.join(configDir, CONFIG_FILE), configContent);

  // Create default credentials.yaml
  const defaultCredentials = `# Slapify Credentials
# WARNING: Do not commit this file to version control!
# This file is gitignored by default

profiles:
  # Default login credentials (for form-based login)
  default:
    type: login-form
    username: \${TEST_USERNAME}
    password: \${TEST_PASSWORD}

  # Example: Admin account with 2FA
  # admin:
  #   type: login-form
  #   username: admin@example.com
  #   password: \${ADMIN_PASSWORD}
  #   totp_secret: JBSWY3DPEHPK3PXP

  # Example: Inject auth token via localStorage
  # token-auth:
  #   type: inject
  #   localStorage:
  #     auth_token: \${AUTH_TOKEN}
  #     user_id: "12345"

  # Example: Inject session via sessionStorage
  # session-auth:
  #   type: inject
  #   sessionStorage:
  #     session_token: \${SESSION_TOKEN}

  # Example: Inject auth cookies
  # cookie-auth:
  #   type: inject
  #   cookies:
  #     - name: auth_token
  #       value: \${AUTH_TOKEN}
  #       domain: .example.com
  #     - name: refresh_token
  #       value: \${REFRESH_TOKEN}
  #       domain: .example.com

  # Example: Combined - cookies + localStorage
  # full-auth:
  #   type: inject
  #   cookies:
  #     - name: session_id
  #       value: \${SESSION_ID}
  #       domain: .example.com
  #   localStorage:
  #     user_preferences: '{"theme":"dark","lang":"en"}'
  #     feature_flags: '{"beta":true}'
`;

  fs.writeFileSync(path.join(configDir, CREDENTIALS_FILE), defaultCredentials);

  // Create tests directory with example
  const testsDir = path.join(targetDir, "tests");
  if (!fs.existsSync(testsDir)) {
    fs.mkdirSync(testsDir, { recursive: true });
  }

  // Create example flow file
  const exampleFlow = `# Example Test - Getting Started with Slapify
# Run with: slapify run tests/example.flow

# Navigate to a website
Go to https://example.com

# Verify the page loaded correctly
Verify page title contains "Example"

# Handle potential popups (won't fail if not present)
[Optional] Close any cookie consent popup

# Interact with the page
Click on "More information" link

# Verify navigation worked
Verify URL contains "iana.org"
`;

  fs.writeFileSync(path.join(testsDir, "example.flow"), exampleFlow);

  // Create .gitignore for credentials
  const gitignore = `credentials.yaml
`;
  fs.writeFileSync(path.join(configDir, ".gitignore"), gitignore);
}

/**
 * Check if a browser is available at a given path
 */
export function checkBrowserPath(browserPath: string): boolean {
  return fs.existsSync(browserPath);
}

/**
 * Find common browser paths on the system
 */
export function findSystemBrowsers(): { name: string; path: string }[] {
  const browsers: { name: string; path: string }[] = [];

  const commonPaths = [
    {
      name: "Google Chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    { name: "Chrome (Linux)", path: "/usr/bin/google-chrome" },
    { name: "Chrome (Linux Alt)", path: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", path: "/usr/bin/chromium" },
    { name: "Chromium (Linux)", path: "/usr/bin/chromium-browser" },
    {
      name: "Chrome (Windows)",
      path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    },
    {
      name: "Chrome (Windows x86)",
      path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    },
    {
      name: "Edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
    {
      name: "Edge (Windows)",
      path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    },
    {
      name: "Brave",
      path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
  ];

  for (const browser of commonPaths) {
    if (fs.existsSync(browser.path)) {
      browsers.push(browser);
    }
  }

  return browsers;
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string | null {
  return findConfigDir();
}
