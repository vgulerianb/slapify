import fs from "fs";
import path from "path";
import { glob } from "glob";
import { FlowFile, FlowStep } from "../types.js";

/**
 * Parse a single line into a FlowStep
 */
function parseLine(line: string, lineNumber: number): FlowStep | null {
  const trimmed = line.trim();

  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  // Check for [Optional] prefix
  const optionalMatch = trimmed.match(/^\[Optional\]\s*(.+)$/i);
  const isOptional = !!optionalMatch;
  const stepText = optionalMatch ? optionalMatch[1] : trimmed;

  // Check for conditional (If ... appears, ...)
  const conditionalMatch = stepText.match(/^If\s+(.+?)\s*,\s*(.+)$/i);
  const isConditional = !!conditionalMatch;

  return {
    line: lineNumber,
    text: stepText,
    optional: isOptional,
    conditional: isConditional,
    condition: conditionalMatch ? conditionalMatch[1] : undefined,
    action: conditionalMatch ? conditionalMatch[2] : undefined,
  };
}

/**
 * Extract comments from a flow file
 */
function extractComments(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.trim().startsWith("#"))
    .map((line) => line.trim().substring(1).trim());
}

/**
 * Parse a .flow file into a FlowFile object
 */
export function parseFlowFile(filePath: string): FlowFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Flow file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const steps: FlowStep[] = [];

  for (let i = 0; i < lines.length; i++) {
    const step = parseLine(lines[i], i + 1);
    if (step) {
      steps.push(step);
    }
  }

  return {
    path: filePath,
    name: path.basename(filePath, ".flow"),
    steps,
    comments: extractComments(content),
  };
}

/**
 * Parse flow content from a string (for inline tests)
 */
export function parseFlowContent(
  content: string,
  name: string = "inline"
): FlowFile {
  const lines = content.split("\n");
  const steps: FlowStep[] = [];

  for (let i = 0; i < lines.length; i++) {
    const step = parseLine(lines[i], i + 1);
    if (step) {
      steps.push(step);
    }
  }

  return {
    path: "",
    name,
    steps,
    comments: extractComments(content),
  };
}

/**
 * Find all .flow files in a directory
 */
export async function findFlowFiles(dir: string): Promise<string[]> {
  const pattern = path.join(dir, "**/*.flow");
  return glob(pattern, { nodir: true });
}

/**
 * Validate a flow file for common issues
 */
export function validateFlowFile(flow: FlowFile): string[] {
  const warnings: string[] = [];

  if (flow.steps.length === 0) {
    warnings.push("Flow file has no steps");
  }

  // Check for steps that might be incomplete
  for (const step of flow.steps) {
    if (step.text.length < 3) {
      warnings.push(`Line ${step.line}: Step seems too short: "${step.text}"`);
    }

    if (step.conditional && !step.action) {
      warnings.push(`Line ${step.line}: Conditional step missing action`);
    }
  }

  return warnings;
}

/**
 * Get a summary of a flow file
 */
export function getFlowSummary(flow: FlowFile): {
  totalSteps: number;
  requiredSteps: number;
  optionalSteps: number;
  conditionalSteps: number;
} {
  return {
    totalSteps: flow.steps.length,
    requiredSteps: flow.steps.filter((s) => !s.optional).length,
    optionalSteps: flow.steps.filter((s) => s.optional).length,
    conditionalSteps: flow.steps.filter((s) => s.conditional).length,
  };
}
