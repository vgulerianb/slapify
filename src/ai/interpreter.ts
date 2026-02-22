import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import {
  LLMConfig,
  FlowStep,
  BrowserState,
  CredentialProfile,
  ActionLog,
} from "../types.js";

/**
 * Get the AI model based on config
 */
export function getModel(
  config: LLMConfig
): Parameters<typeof generateText>[0]["model"] {
  switch (config.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.api_key });
      return anthropic(config.model) as Parameters<
        typeof generateText
      >[0]["model"];
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: config.api_key });
      return openai(config.model) as Parameters<
        typeof generateText
      >[0]["model"];
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.api_key });
      return google(config.model) as Parameters<
        typeof generateText
      >[0]["model"];
    }
    case "mistral": {
      const mistral = createMistral({ apiKey: config.api_key });
      return mistral(config.model) as Parameters<
        typeof generateText
      >[0]["model"];
    }
    case "groq": {
      const groq = createGroq({ apiKey: config.api_key });
      return groq(config.model) as Parameters<typeof generateText>[0]["model"];
    }
    case "ollama": {
      // Ollama uses OpenAI-compatible API
      const ollama = createOpenAI({
        apiKey: "ollama", // Ollama doesn't need a real key
        baseURL: config.base_url || "http://localhost:11434/v1",
      });
      return ollama(config.model) as Parameters<
        typeof generateText
      >[0]["model"];
    }
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

/**
 * AI interpreter for converting natural language steps to browser actions
 */
export class AIInterpreter {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Interpret a step and generate browser commands
   */
  async interpretStep(
    step: FlowStep,
    browserState: BrowserState,
    credentials?: Record<string, CredentialProfile>
  ): Promise<InterpretedStep> {
    const model = getModel(this.config);

    const systemPrompt = `You are a browser automation assistant. Your job is to interpret natural language test steps and convert them to specific browser actions.

You have access to a browser with the following current state:
- URL: ${browserState.url}
- Title: ${browserState.title}
- Page snapshot (accessibility tree with refs):
${browserState.snapshot}

Available browser commands:
- navigate(url) - Go to a URL
- click(ref) - Click element by ref (e.g., @e1)
- fill(ref, value) - Fill input field
- type(ref, value) - Type text (append)
- press(key) - Press keyboard key
- hover(ref) - Hover over element
- select(ref, value) - Select dropdown option
- scroll(direction, amount?) - Scroll page
- wait(ms) - Wait milliseconds
- waitForText(text) - Wait for text to appear
- getText(ref) - Get element text
- screenshot(path?) - Take screenshot
- goBack() - Navigate back
- reload() - Reload page

${
  credentials && Object.keys(credentials).length > 0
    ? `Available credential profiles: ${Object.keys(credentials).join(", ")}. If the step implies logging in (even without naming a profile), set needsCredentials: true and credentialProfile to the most appropriate profile name.`
    : ""
}

Respond with a JSON object:
{
  "actions": [
    { "command": "click", "args": ["@e5"], "description": "Click the login button" }
  ],
  "assumptions": ["Assumed 'login button' refers to the element labeled 'Sign In'"],
  "needsCredentials": false,
  "credentialProfile": null,
  "skipReason": null,
  "verified": false
}

IMPORTANT RULES:
- If the step implies logging in (e.g. "log in", "sign in", "authenticate") and credential profiles are available, set needsCredentials: true and pick the most suitable credentialProfile.
- For "Verify" steps: If the verification PASSES, set "verified": true and include a description in actions. Do NOT use skipReason for successful verifications.
- skipReason should ONLY be used when a step cannot be completed or should be skipped (element not found, condition not met, etc.)
- If the step is a verification and it passes based on current page state, that's a SUCCESS - set verified: true.
- If the step is a verification and it fails, set skipReason to explain why it failed.
- NEVER mention or expose credential values (passwords, tokens) in actions or assumptions.`;

    const userPrompt = `Interpret this test step and provide browser commands:

Step: "${step.text}"
${
  step.optional
    ? "(This step is optional - can be skipped if not applicable)"
    : ""
}
${
  step.conditional
    ? `Condition: "${step.condition}" → Action: "${step.action}"`
    : ""
}`;

    const response = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: 1000,
    });

    try {
      // Extract JSON from response
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const result = JSON.parse(jsonMatch[0]);

      return {
        actions: result.actions || [],
        assumptions: result.assumptions || [],
        needsCredentials: result.needsCredentials || false,
        credentialProfile: result.credentialProfile || null,
        skipReason: result.skipReason || null,
      };
    } catch (error) {
      // Fallback: try to parse as simple command
      return {
        actions: [],
        assumptions: [],
        needsCredentials: false,
        credentialProfile: null,
        skipReason: `Failed to interpret step: ${error}`,
      };
    }
  }

  /**
   * Check for auto-handle opportunities (popups, banners, etc.)
   */
  async checkAutoHandle(
    browserState: BrowserState
  ): Promise<AutoHandleAction[]> {
    const model = getModel(this.config);

    const systemPrompt = `You are analyzing a webpage for common interruptions that should be automatically handled during test automation.

Page snapshot:
${browserState.snapshot}

Look for these common interruptions:
1. Cookie consent banners (GDPR, etc.)
2. Newsletter signup popups
3. "Allow notifications" prompts
4. Chat widgets that might block content
5. Age verification dialogs
6. Promotional popups/modals
7. "Sign up for deals" overlays

IMPORTANT: When dismissing interruptions, ALWAYS prefer these buttons in order:
- For cookie banners: "Accept", "Accept All", "Allow", "Agree", "OK", "Got it", "Save changes", close button (X)
- NEVER click "Manage", "Customize", "Settings", "Preferences", "Learn more" as these open MORE dialogs
- For popups/modals: Close button (X), "No thanks", "Maybe later", "Skip", "Dismiss"
- For notifications: "Block", "Not now", "Later"

The goal is to DISMISS/CLOSE the interruption with ONE click, not configure it.

Respond with JSON:
{
  "interruptions": [
    { "type": "cookie-banner", "ref": "@e15", "action": "click", "description": "Click Accept to dismiss cookie banner" }
  ]
}

If no interruptions found, return: { "interruptions": [] }`;

    const response = await generateText({
      model,
      system: systemPrompt,
      prompt: "Analyze this page for interruptions to auto-handle.",
      maxTokens: 500,
    });

    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const result = JSON.parse(jsonMatch[0]);
      return result.interruptions || [];
    } catch {
      return [];
    }
  }

  /**
   * Analyze page to find login form for credentials injection
   */
  async findLoginForm(
    browserState: BrowserState
  ): Promise<LoginFormInfo | null> {
    const model = getModel(this.config);

    const systemPrompt = `You are analyzing a webpage to find login form elements.

Page snapshot:
${browserState.snapshot}

Find:
1. Username/email input field (ref)
2. Password input field (ref)
3. Submit/login button (ref)

Respond with JSON:
{
  "found": true,
  "usernameRef": "@e1",
  "passwordRef": "@e2",
  "submitRef": "@e3"
}

If no login form found: { "found": false }`;

    const response = await generateText({
      model,
      system: systemPrompt,
      prompt: "Find the login form elements on this page.",
      maxTokens: 300,
    });

    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const result = JSON.parse(jsonMatch[0]);
      if (!result.found) return null;

      return {
        usernameRef: result.usernameRef,
        passwordRef: result.passwordRef,
        submitRef: result.submitRef,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify an assertion/condition on the page
   */
  async verifyCondition(
    condition: string,
    browserState: BrowserState
  ): Promise<VerificationResult> {
    const model = getModel(this.config);

    const systemPrompt = `You are verifying a condition on a webpage.

Page URL: ${browserState.url}
Page Title: ${browserState.title}
Page snapshot:
${browserState.snapshot}

Respond with JSON:
{
  "satisfied": true,
  "evidence": "Found the text 'Welcome' in heading @e5",
  "suggestion": null
}

Or if not satisfied:
{
  "satisfied": false,
  "evidence": "Could not find any element containing 'Welcome'",
  "suggestion": "The page might still be loading, or the user might not be logged in"
}`;

    const response = await generateText({
      model,
      system: systemPrompt,
      prompt: `Verify this condition: "${condition}"`,
      maxTokens: 300,
    });

    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          satisfied: false,
          evidence: "Could not parse verification result",
        };
      }

      const result = JSON.parse(jsonMatch[0]);
      return {
        satisfied: result.satisfied,
        evidence: result.evidence,
        suggestion: result.suggestion,
      };
    } catch {
      return { satisfied: false, evidence: "Verification failed" };
    }
  }

  /**
   * Find the captcha interaction element on the current page.
   * Returns the ref to click (e.g. the "I'm not a robot" checkbox) or null.
   */
  async findCaptchaAction(
    browserState: BrowserState
  ): Promise<{ ref: string; description: string } | null> {
    const model = getModel(this.config);

    const systemPrompt = `You are analyzing a webpage that contains a CAPTCHA challenge.

Page snapshot:
${browserState.snapshot}

Find the primary interactive captcha element — the checkbox, button, or iframe the user should click to begin solving (e.g. "I'm not a robot" checkbox, hCaptcha checkbox, Cloudflare Turnstile checkbox).

Respond with JSON:
{ "found": true, "ref": "@e5", "description": "reCAPTCHA I'm not a robot checkbox" }

If no clickable captcha element is visible: { "found": false }`;

    try {
      const response = await generateText({
        model,
        system: systemPrompt,
        prompt: "Find the captcha element to click.",
        maxTokens: 200,
      });

      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const result = JSON.parse(jsonMatch[0]);
      if (!result.found || !result.ref) return null;

      return { ref: result.ref, description: result.description || "captcha" };
    } catch {
      return null;
    }
  }
}

// Types for interpreter results
export interface InterpretedStep {
  actions: BrowserCommand[];
  assumptions: string[];
  needsCredentials: boolean;
  credentialProfile: string | null;
  skipReason: string | null;
  verified?: boolean; // For verification steps that pass
}

export interface BrowserCommand {
  command: string;
  args: string[];
  description: string;
}

export interface AutoHandleAction {
  type: string;
  ref: string;
  action: string;
  description: string;
}

export interface LoginFormInfo {
  usernameRef: string;
  passwordRef: string;
  submitRef: string;
}

export interface VerificationResult {
  satisfied: boolean;
  evidence: string;
  suggestion?: string;
}
