# Kaseya VSA MCP Server

[![Release](https://github.com/WYRE-AI/kaseya-vsa-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/WYRE-AI/kaseya-vsa-mcp/actions/workflows/release.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Model Context Protocol (MCP) server for the Kaseya VSA RMM API.
Exposes managed endpoints, software / hardware inventory, patch state, agent
procedures, alarms, Service Desk tickets, organizations, and machine groups
to AI assistants.

## Tools

| Tool | Description |
|------|-------------|
| `kaseya_vsa_list_agents` | List managed endpoints (agents). Optional `$filter`. |
| `kaseya_vsa_get_agent` | Get an agent's details by ID (renders as an interactive card in MCP Apps hosts). |
| `kaseya_vsa_get_software_inventory` | Installed software for an agent. |
| `kaseya_vsa_get_hardware_inventory` | Hardware audit for an agent. |
| `kaseya_vsa_get_patch_status` | Pending and installed patches for an agent. |
| `kaseya_vsa_deploy_patches_now` | Force a patch deploy on an agent (destructive — confirmation required). |
| `kaseya_vsa_list_procedures` | Agent procedures available to run. |
| `kaseya_vsa_run_procedure` | Execute a procedure on an agent (destructive — confirmation required). |
| `kaseya_vsa_list_alarms` | Open alarms (optional state filter; date-window elicitation if missing). |
| `kaseya_vsa_list_tickets` | Service Desk tickets (returns a friendly message if SD module isn't enabled). |
| `kaseya_vsa_list_organizations` | Tenant organizations. |
| `kaseya_vsa_list_machine_groups` | Machine group hierarchy. |

When the user omits required filters or runs a destructive action, the server
uses MCP elicitation to prompt for choices or confirm.

### Interactive device card (MCP Apps)

`kaseya_vsa_get_agent` renders as a read-only interactive device card in MCP
Apps hosts (Claude Desktop/web), showing the endpoint's name, online status,
organization, machine group, OS, IP address, and last check-in. The card is
neutral by default, brandable via `window.__BRAND__` injection or
`MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
`MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
`MCP_BRAND_TEXT`) applied at serve time. Plain-JSON behavior is unchanged in
other hosts. After editing `ui/`, regenerate the embedded bundle with
`npm run build:ui`.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below.

| Variable | Required | Description |
|----------|----------|-------------|
| `KASEYA_VSA_TENANT_URL` | For stdio and `AUTH_MODE=env` | Full base URL incl. `/api/v1.0`. The Compose gateway service does not load this. |
| `KASEYA_VSA_USERNAME` | For stdio and `AUTH_MODE=env` | Local-auth username (with password). The Compose gateway service does not load this. |
| `KASEYA_VSA_PASSWORD` | For stdio and `AUTH_MODE=env` | Local-auth password (secret). The Compose gateway service does not load this. |
| `KASEYA_VSA_K1_TOKEN` | For stdio and `AUTH_MODE=env` | Kaseya One SSO token (alternative to username + password). The Compose gateway service does not load this. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env` (code default when unset). Gateway mode requires the `X-Kaseya-VSA-*` headers on each `/mcp` request and never falls back to `KASEYA_VSA_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. Generate with `openssl rand -hex 32`. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `your-s2s-secret`, `secret`, `placeholder`, an unresolved `${...}` value, and similar public examples). Compose will not start without it. Never commit a real value. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and forces the listener onto `127.0.0.1` even if `MCP_HTTP_HOST` is a wider address. A known placeholder secret is still refused. |
| `MCP_HTTP_HOST` | No | Bind address when `MCP_TRANSPORT=http`. Defaults to `127.0.0.1` when unset. A configured `CONDUIT_S2S_SECRET` honors this value. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

Either the username + password pair OR `KASEYA_VSA_K1_TOKEN` is required for stdio and `AUTH_MODE=env`.

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns HTTP 401 before vendor credentials are read.

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Kaseya-VSA-Tenant-Url` plus either (`X-Kaseya-VSA-Username` and `X-Kaseya-VSA-Password`) or `X-Kaseya-VSA-K1-Token`. Those headers are the only credential source for that request. A request missing them returns 401 and does not fall back to `KASEYA_VSA_*` in the process environment.

Each accepted request creates a fresh server instance with isolated credentials — no cross-tenant `process.env` pollution.

## Local development

```bash
npm install
npm run build
KASEYA_VSA_TENANT_URL=https://vsa.example.com/api/v1.0 \
  KASEYA_VSA_USERNAME=... \
  KASEYA_VSA_PASSWORD=... \
  npm start
```

HTTP refuses to start until `CONDUIT_S2S_SECRET` is set:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http npm start
curl http://127.0.0.1:8080/health
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` only and logs a warning. A non-loopback `MCP_HTTP_HOST` is ignored and the override is logged:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Kaseya credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t kaseya-vsa-mcp .
docker run --rm \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  kaseya-vsa-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not inject static `KASEYA_VSA_*` credentials, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `KASEYA_VSA_*`:

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e KASEYA_VSA_TENANT_URL=https://vsa.example.com/api/v1.0 \
  -e KASEYA_VSA_USERNAME=... \
  -e KASEYA_VSA_PASSWORD=... \
  -p 127.0.0.1:8080:8080 \
  kaseya-vsa-mcp
```

## License

Apache-2.0
