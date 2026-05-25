#!/usr/bin/env node

// Seiva Support MCP — read-only platform-admin tools for Claude Code.
// Auth: SEIVA_PLATFORM_TOKEN is a JWT issued by `mix seiva.platform_admin.token <email>`.
// Server URL: SEIVA_URL (defaults to https://seiva.fly.dev).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEIVA_URL = process.env.SEIVA_URL || "http://localhost:4000";
const SEIVA_PLATFORM_TOKEN = process.env.SEIVA_PLATFORM_TOKEN;

if (!SEIVA_PLATFORM_TOKEN) {
  console.error("SEIVA_PLATFORM_TOKEN environment variable is required");
  console.error("Generate one with:  mix seiva.platform_admin.token <your-email>");
  process.exit(1);
}

async function api(path, params) {
  const url = new URL(`${SEIVA_URL}/api/v1/platform${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      authorization: `Bearer ${SEIVA_PLATFORM_TOKEN}`,
      accept: "application/json",
    },
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: non-JSON response`);
  }

  if (!res.ok) {
    const detail = json.message ? ` — ${json.message}` : "";
    throw new Error(`HTTP ${res.status}: ${json.error || "error"}${detail}`);
  }

  return json;
}

function tool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      const data = await handler(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}

const server = new McpServer({ name: "seiva-support", version: "0.1.0" });

// ── User lookup ─────────────────────────────────────────────────────────────

tool(
  server,
  "seiva_support_find_user",
  "Look up a user by email (preferred) or id. Returns the user record plus all workspace memberships (with role, partnership_id, last_visited_at). Start triage from here when a customer reports a bug.",
  {
    email: z.string().optional().describe("User email (case-insensitive)"),
    id: z.string().optional().describe("User UUID — alternative to email"),
  },
  ({ email, id }) => api("/users/find", { email, id })
);

// ── Workspace / app overview ────────────────────────────────────────────────

tool(
  server,
  "seiva_support_workspace_overview",
  "Aggregate health snapshot for a workspace: app/error/usage counts in the window plus recent error samples. Use this after find_user to focus on the affected workspace.",
  {
    workspace_id: z.string(),
    since: z.string().optional().describe("Window: '24h', '7d', or RFC3339 timestamp. Default 24h."),
  },
  ({ workspace_id, since }) => api(`/workspaces/${workspace_id}/overview`, { since })
);

tool(
  server,
  "seiva_support_app_overview",
  "Compact view of a single app: metadata + 24h totals + 10 most recent errors.",
  { app_id: z.string() },
  ({ app_id }) => api(`/apps/${app_id}/overview`)
);

// ── DB-backed log queries ───────────────────────────────────────────────────

const logFilters = {
  workspace_id: z.string().optional(),
  app_id: z.string().optional(),
  user_id: z.string().optional(),
  since: z.string().optional().describe("'15m', '24h', '7d' or RFC3339"),
  limit: z.number().int().optional().describe("Default 100, capped at 1000"),
};

tool(
  server,
  "seiva_support_app_error_logs",
  "Recent rows from `app_error_logs` (frontend runtime errors captured by the app SDK). Filterable by workspace/app/environment.",
  { ...logFilters, environment: z.string().optional() },
  (args) => api("/logs/app_errors", args)
);

tool(
  server,
  "seiva_support_app_usage_logs",
  "Recent rows from `app_usage_logs` (data API calls from running apps). Filterable by action/status/workspace/app/user.",
  { ...logFilters, action: z.string().optional(), status: z.string().optional() },
  (args) => api("/logs/app_usage", args)
);

tool(
  server,
  "seiva_support_chat_logs",
  "Recent rows from `chat_agent_logs` (Matthew + agent session events: tool calls, errors, iterations). Filter by session_id when investigating one conversation.",
  {
    session_id: z.string().optional(),
    workspace_id: z.string().optional(),
    user_id: z.string().optional(),
    app_id: z.string().optional(),
    level: z.string().optional().describe("info | warn | error"),
    source: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().int().optional(),
  },
  (args) => api("/logs/chat_agent", args)
);

tool(
  server,
  "seiva_support_audit_logs",
  "Recent rows from `workspace_audit_logs` (admin actions: grants, role changes, publishes). Use to answer 'who changed X?' questions.",
  {
    workspace_id: z.string().optional(),
    user_id: z.string().optional(),
    resource_type: z.string().optional(),
    resource_id: z.string().optional(),
    action: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().int().optional(),
  },
  (args) => api("/logs/audit", args)
);

tool(
  server,
  "seiva_support_execution_logs",
  "Recent rows from `execution_logs` (workflow node-level events). Filter by execution_id to follow one run end-to-end.",
  {
    execution_id: z.string().optional(),
    level: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().int().optional(),
  },
  (args) => api("/logs/executions", args)
);

tool(
  server,
  "seiva_support_usage_events",
  "Recent rows from `usage_events` (LLM token counts and API calls per workspace/app/service).",
  {
    workspace_id: z.string().optional(),
    partnership_id: z.string().optional(),
    user_id: z.string().optional(),
    app_id: z.string().optional(),
    service: z.string().optional(),
    event_type: z.string().optional(),
    model: z.string().optional(),
    since: z.string().optional(),
    limit: z.number().int().optional(),
  },
  (args) => api("/logs/usage_events", args)
);

// ── External: Fly.io ───────────────────────────────────────────────────────

tool(
  server,
  "seiva_support_fly_logs",
  "Recent BEAM/Phoenix log lines from the Fly.io app. Use when the bug is server-side (timeouts, supervisor crashes, slow queries).",
  {
    since: z.string().optional().describe("RFC3339 timestamp"),
    region: z.string().optional(),
    instance: z.string().optional().describe("Fly machine id"),
    vm_type: z.string().optional(),
    limit: z.number().int().optional(),
  },
  (args) => api("/fly/logs", args)
);

// ── External: Cloud Run ────────────────────────────────────────────────────

tool(
  server,
  "seiva_support_cloudrun_services",
  "List the Cloud Run services and severities the support MCP can query (avoid guessing).",
  {},
  () => api("/cloudrun/services")
);

tool(
  server,
  "seiva_support_cloudrun_logs",
  "Recent log entries for one Cloud Run microservice. Use when the bug points at App Builder (code_builder), running app (app_runner), Python sandbox (code_runner_python) or DuckLake analytics (analytics_runner).",
  {
    service: z.enum(["code_builder", "app_runner", "code_runner_python", "analytics_runner"]),
    severity: z.string().optional().describe("DEFAULT|DEBUG|INFO|NOTICE|WARNING|ERROR|CRITICAL|ALERT|EMERGENCY"),
    contains: z.string().optional().describe("Substring filter on textPayload / jsonPayload.message"),
    since: z.string().optional().describe("'15m', '24h' or RFC3339"),
    limit: z.number().int().optional(),
  },
  (args) => api("/cloudrun/logs", args)
);

// ── External: Sentry ───────────────────────────────────────────────────────

tool(
  server,
  "seiva_support_sentry_issues",
  "Recent Sentry issues for the configured project. Use to discover error trends or correlate with a user-reported timestamp.",
  {
    query: z.string().optional().describe("Sentry query DSL, e.g. 'is:unresolved'"),
    stats_period: z.string().optional().describe("e.g. '24h', '7d'"),
    limit: z.number().int().optional(),
  },
  (args) => api("/sentry/issues", args)
);

tool(
  server,
  "seiva_support_sentry_issue_detail",
  "Full payload for one Sentry issue.",
  { issue_id: z.string() },
  ({ issue_id }) => api(`/sentry/issues/${issue_id}`)
);

tool(
  server,
  "seiva_support_sentry_issue_events",
  "Recent events (occurrences) for one Sentry issue.",
  { issue_id: z.string(), limit: z.number().int().optional() },
  ({ issue_id, limit }) => api(`/sentry/issues/${issue_id}/events`, { limit })
);

// ── Runtime introspection (best-effort, single node) ───────────────────────

tool(
  server,
  "seiva_support_builder_status",
  "Best-effort peek at the App Builder 'thinking' flag for one (workspace, app). Reads ETS on the responding node only — may miss state on other pods.",
  { workspace_id: z.string(), app_id: z.string() },
  ({ workspace_id, app_id }) =>
    api("/runtime/builder_status", { workspace_id, app_id })
);

tool(
  server,
  "seiva_support_oban_jobs",
  "Recent Oban jobs. Use state='discarded' to find dead jobs that need a manual look.",
  {
    state: z.string().optional().describe("available | scheduled | executing | retryable | discarded | completed"),
    queue: z.string().optional(),
    limit: z.number().int().optional(),
  },
  (args) => api("/runtime/oban_jobs", args)
);

tool(
  server,
  "seiva_support_cluster_info",
  "Returns the responding node, connected nodes and OTP release. Sanity check before relying on ETS-backed tools.",
  {},
  () => api("/runtime/cluster")
);

// ── Self-audit ─────────────────────────────────────────────────────────────

tool(
  server,
  "seiva_support_audit_self",
  "Recent calls made by *you* (the current platform admin). Useful to verify what tools you've already invoked in this session.",
  { limit: z.number().int().optional() },
  (args) => api("/audit", args)
);

// ── Connect ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
