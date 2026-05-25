# `@seiva-ai/support-mcp-server`

Read-only MCP server that lets a Seiva **platform admin** triage production
bugs from Claude Code. Aggregates logs from the Seiva DB, the Fly.io app,
the Cloud Run microservices (`code_builder`, `app_runner`,
`code_runner_python`, `analytics_runner`) and Sentry.

This is **separate** from [`@seiva-ai/mcp-server`](https://www.npmjs.com/package/@seiva-ai/mcp-server) (workspace/partnership management).
Defense-in-depth: a leaked workspace API key cannot reach support tools.

## Who can use this

Anyone whose email is listed in `PLATFORM_ADMIN_EMAILS` on the Seiva server.
The list is consulted on **every** request, so removing an email is the
revocation mechanism — the JWT itself is stateless.

## Setup

1. **Provision the server** (Phoenix, one-time):

   ```bash
   fly secrets set \
     PLATFORM_ADMIN_EMAILS="alice@example.com,bob@example.com" \
     FLY_API_TOKEN="$(fly tokens create deploy --read-only)" \
     GCP_PROJECT_ID="seiva-prod" \
     SENTRY_AUTH_TOKEN="..." \
     SENTRY_ORG="seiva" \
     SENTRY_PROJECT="seiva"
   ```

   Locally during dev, add the same vars to `server/.env` and restart Phoenix.

   The Phoenix service account on GCP needs `roles/logging.viewer`. The Fly
   token must have `read` scope. The Sentry token must have at least
   `event:read` and `project:read`.

2. **Generate your personal token** (once per admin, 90-day TTL by default):

   ```bash
   cd server
   mix seiva.platform_admin.token alice@example.com --ttl-days 90
   ```

   Copy the printed token.

3. **Wire it into Claude Code** — add to `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "seiva-support": {
         "command": "npx",
         "args": ["-y", "@seiva-ai/support-mcp-server"],
         "env": {
           "SEIVA_PLATFORM_TOKEN": "eyJ...your-token-here",
           "SEIVA_URL": "https://platform.seiva.ai"
         }
       }
     }
   }
   ```

   Or register via `claude mcp add-json --scope user` (Claude Code user scope).
   Restart Claude Code. The new tools appear with the `seiva_support_*`
   prefix.

## Available tools

| Tool | Purpose |
|---|---|
| `seiva_support_find_user` | User + workspaces + memberships |
| `seiva_support_workspace_overview` | Aggregate health snapshot |
| `seiva_support_app_overview` | Single app, 24h totals + recent errors |
| `seiva_support_app_error_logs` | `app_error_logs` (frontend runtime errors) |
| `seiva_support_app_usage_logs` | `app_usage_logs` (data API calls) |
| `seiva_support_chat_logs` | `chat_agent_logs` (Matthew + agent sessions) |
| `seiva_support_audit_logs` | `workspace_audit_logs` (admin actions) |
| `seiva_support_execution_logs` | `execution_logs` (workflow node-level) |
| `seiva_support_usage_events` | `usage_events` (LLM tokens / API calls) |
| `seiva_support_fly_logs` | Fly.io BEAM/Phoenix log stream |
| `seiva_support_cloudrun_services` | Allowed services + severity values |
| `seiva_support_cloudrun_logs` | One Cloud Run service's logs |
| `seiva_support_sentry_issues` | Recent Sentry issues |
| `seiva_support_sentry_issue_detail` | Full Sentry issue payload |
| `seiva_support_sentry_issue_events` | Recent occurrences for an issue |
| `seiva_support_builder_status` | App Builder ETS state (best-effort, single node) |
| `seiva_support_oban_jobs` | Recent Oban jobs (filter by state/queue) |
| `seiva_support_cluster_info` | Responding node + connected nodes |
| `seiva_support_audit_self` | Your own recent calls (transparency) |

`since` accepts `'15m'`, `'24h'`, `'7d'` (relative) or RFC3339 timestamps.
`limit` defaults to 100, capped at 1000.

## Security notes

- **Read-only.** All endpoints are `GET`. Mutations are deliberately not
  exposed.
- **Per-call audit.** Every request (including 4xx/5xx) is recorded in
  `platform_audit_logs` with admin email, path, status and duration. View
  your own with `seiva_support_audit_self`.
- **Rate limited.** 60 req/min per IP. Don't loop over Cloud Run.
- **Service allowlist.** Only the four Cloud Run services above are
  reachable, to prevent log-filter injection.
- **PII scrub.** `args_summary` in audit rows is redacted for fields
  matching `password`, `token`, `api_key`, `secret`, `authorization`,
  `auth`, `credential` before insertion.
- **Token revocation.** Remove the email from `PLATFORM_ADMIN_EMAILS`
  on the server. Existing tokens become inert immediately even if they
  haven't expired.

## Limitations (known)

- ETS state (`seiva_support_builder_status`) is local to the responding
  pod. Use `seiva_support_cluster_info` to see which node served the
  call, and retry if needed.
- No streaming. Each tool returns a snapshot — pass `since` to advance.
- Sentry rate limits apply (60 req/min per token).
