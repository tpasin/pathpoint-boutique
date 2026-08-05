// @pathpoint-source panel:cursor
import { Agent, CursorAgentError, type AgentOptions } from "@cursor/sdk";

export type CursorAskResult = {
  agentId: string;
  runId: string;
  status: string;
  response: string;
  durationMs?: number;
  runtime: "local" | "cloud";
  error?: string;
};

function requireApiKey(): string {
  const key = (process.env["CURSOR_API_KEY"] || "").trim();
  if (!key) {
    throw new Error(
      "Set CURSOR_API_KEY in the server env (Cursor Dashboard → Integrations)."
    );
  }
  return key;
}

export function cursorConfigured(): boolean {
  return Boolean((process.env["CURSOR_API_KEY"] || "").trim());
}

/** Soft switch — panel stays visible when false, but asks are rejected. */
export function cursorEnabled(): boolean {
  const flag = (process.env["CURSOR_ENABLED"] || "true").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return false;
  }
  return cursorConfigured();
}

export function cursorRuntime(): "local" | "cloud" {
  const forced = (process.env["CURSOR_RUNTIME"] || "").trim().toLowerCase();
  if (forced === "cloud" || forced === "local") return forced;
  return process.env["CURSOR_CLOUD_REPO"] ? "cloud" : "local";
}

function buildOptions(apiKey: string): AgentOptions {
  const modelId = process.env["CURSOR_MODEL"] || "composer-2.5";
  const runtime = cursorRuntime();
  const opts: AgentOptions = {
    apiKey,
    model: { id: modelId },
    name: "Pathpoint Boutique",
  };

  if (runtime === "cloud") {
    const repo = (process.env["CURSOR_CLOUD_REPO"] || "").trim();
    if (!repo) {
      throw new Error(
        "CURSOR_RUNTIME=cloud requires CURSOR_CLOUD_REPO (git URL)."
      );
    }
    opts.cloud = {
      repos: [{ url: repo, startingRef: process.env["CURSOR_CLOUD_REF"] || "main" }],
      skipReviewerRequest: true,
    };
  } else {
    const cwd =
      process.env["CURSOR_AGENT_CWD"] ||
      process.env["PWD"] ||
      process.cwd();
    opts.local = {
      cwd,
      // Keep ambient IDE settings out of the headless service.
      settingSources: [],
    };
  }

  return opts;
}

function buildPrompt(message: string, context?: {
  start?: string;
  end?: string;
  stage?: string;
}): string {
  const parts = [
    "You are assisting from the Boutique Pathpoint dashboard for Coralogix astronomy-demo / Online Boutique.",
    "Investigate using the local Pathpoint codebase and any available tools. Be concrete and concise.",
  ];
  if (context?.start && context?.end) {
    parts.push(`Dashboard time window: ${context.start} → ${context.end}.`);
  }
  if (context?.stage) {
    parts.push(`Focus stage: ${context.stage}.`);
  }
  parts.push(`User request: ${message}`);
  return parts.join("\n");
}

/** One-shot or follow-up Cursor agent ask (create / resume + wait). */
export async function askCursor(opts: {
  message: string;
  agentId?: string;
  start?: string;
  end?: string;
  stage?: string;
}): Promise<CursorAskResult> {
  const apiKey = requireApiKey();
  const runtime = cursorRuntime();
  const base = buildOptions(apiKey);
  const prompt = buildPrompt(opts.message.trim(), opts);

  await using agent = opts.agentId
    ? await Agent.resume(opts.agentId, base)
    : await Agent.create(base);

  try {
    const run = await agent.send(prompt);
    const result = await run.wait();
    const response =
      result.result ||
      (result.status === "error"
        ? result.error?.message || "Cursor agent run failed"
        : "(empty response)");

    return {
      agentId: agent.agentId,
      runId: result.id,
      status: result.status,
      response,
      durationMs: result.durationMs,
      runtime,
      error:
        result.status === "error"
          ? result.error?.message || "Cursor agent run failed"
          : undefined,
    };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(
        `Cursor agent startup failed: ${err.message}${err.isRetryable ? " (retryable)" : ""}`
      );
    }
    throw err;
  }
}
