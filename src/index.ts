#!/usr/bin/env node
/**
 * Kaseya VSA MCP Server
 *
 * This MCP server provides tools for interacting with the Kaseya VSA RMM API.
 * It accepts credentials via environment variables (env mode) or per-request
 * HTTP headers (gateway mode). Gateway mode never falls back to KASEYA_VSA_*
 * env credentials. Supports both stdio (default) and HTTP (StreamableHTTP)
 * transports.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * MCP_ALLOW_INSECURE_DEV=1 is a local-only escape hatch: it logs a warning and
 * forces the listener onto 127.0.0.1. Known placeholder secrets are rejected
 * even with that flag. /health stays unauthenticated and does not read
 * credentials. stdio does not use S2S auth.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { KaseyaVsaClient, type VsaAgent } from "@wyre-technology/node-kaseya-vsa";
import { bindServerRef, runWithServerRef } from "./utils/server-ref.js";
import { elicitConfirmation, elicitSelection, elicitText } from "./utils/elicitation.js";
import {
  DEVICE_CARD_META,
  DEVICE_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
  applyBrandInjection,
  brandFromEnv,
  buildDeviceCard,
} from "./device-card.js";
import { DEVICE_CARD_HTML } from "./generated/device-card-html.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface KaseyaVsaCredentials {
  baseUrl: string;
  username?: string;
  password?: string;
  kaseyaOneToken?: string;
}

// An unresolved MCPB/DXT manifest placeholder, e.g. "${user_config.kaseya_vsa_k1_token}".
// Desktop hosts inject the config template verbatim when its optional user_config
// field is left blank, so the literal string arrives in the env var / header.
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Normalise a single credential read from an env var or gateway header.
 *
 * Returns `undefined` for values that are effectively absent, so the auth layer
 * treats them as "no credential" rather than a real secret:
 *   - undefined / empty / whitespace-only
 *   - an unresolved manifest placeholder like `${user_config.kaseya_vsa_k1_token}`
 *
 * Root cause of issue #73: a blank optional Kaseya One token field left the literal
 * `${user_config.kaseya_vsa_k1_token}` in KASEYA_VSA_K1_TOKEN. Because that token
 * (when truthy) is preferred over local username/password in createClient, every
 * request authenticated with the bogus placeholder as the SSO token and failed —
 * even with valid local credentials configured. Stripping the placeholder here lets
 * local auth take over.
 */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

export function getCredentials(): KaseyaVsaCredentials | null {
  const baseUrl = cleanCredential(process.env.KASEYA_VSA_TENANT_URL);
  if (!baseUrl) return null;
  const username = cleanCredential(process.env.KASEYA_VSA_USERNAME);
  const password = cleanCredential(process.env.KASEYA_VSA_PASSWORD);
  const kaseyaOneToken = cleanCredential(process.env.KASEYA_VSA_K1_TOKEN);
  const hasLocal = !!(username && password);
  if (!hasLocal && !kaseyaOneToken) return null;
  return { baseUrl, username, password, kaseyaOneToken };
}

export function createClient(creds: KaseyaVsaCredentials): KaseyaVsaClient {
  const opts: Record<string, unknown> = { baseUrl: creds.baseUrl };
  if (creds.kaseyaOneToken) {
    opts.kaseyaOneToken = creds.kaseyaOneToken;
  } else {
    opts.username = creds.username;
    opts.password = creds.password;
  }
  return new KaseyaVsaClient(opts as never);
}

// ---------------------------------------------------------------------------
// Server factory — fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

export function createMcpServer(credentialOverrides?: KaseyaVsaCredentials): Server {
  const server = new Server(
    {
      name: "kaseya-vsa-mcp",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    }
  );

  // The caller owns binding this server into server-ref.ts's scope now
  // (bindServerRef for stdio's single session, runWithServerRef wrapping
  // the whole per-request chain for HTTP) — createMcpServer() stays
  // side-effect-free with respect to server-ref.

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "kaseya_vsa_list_agents",
          description:
            "List managed endpoints (agents) in the Kaseya VSA tenant. Supports OData $filter, $top, $skip. If no filter is provided, the user is prompted to choose a scope.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 100)", default: 100 },
              skip: { type: "number", description: "Records to skip" },
            },
          },
        },
        {
          name: "kaseya_vsa_get_agent",
          description: "Get details for a managed endpoint by agent ID.",
          _meta: DEVICE_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier (AgentGuid)" },
            },
            required: ["agentId"],
          },
        },
        {
          name: "kaseya_vsa_get_software_inventory",
          description: "Get installed software for an endpoint (audit data).",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier" },
            },
            required: ["agentId"],
          },
        },
        {
          name: "kaseya_vsa_get_hardware_inventory",
          description: "Get hardware audit data for an endpoint.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier" },
            },
            required: ["agentId"],
          },
        },
        {
          name: "kaseya_vsa_get_patch_status",
          description: "Get patch status (pending and installed) for an endpoint.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier" },
            },
            required: ["agentId"],
          },
        },
        {
          name: "kaseya_vsa_deploy_patches_now",
          description:
            "Force a patch deploy on an endpoint immediately. DESTRUCTIVE: requires user confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier" },
            },
            required: ["agentId"],
          },
        },
        {
          name: "kaseya_vsa_list_procedures",
          description: "List agent procedures available to run on an endpoint.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier" },
            },
            required: ["agentId"],
          },
        },
        {
          name: "kaseya_vsa_run_procedure",
          description:
            "Execute an agent procedure on an endpoint. DESTRUCTIVE: requires user confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent identifier" },
              procedureId: { type: "string", description: "Procedure identifier" },
            },
            required: ["agentId", "procedureId"],
          },
        },
        {
          name: "kaseya_vsa_list_alarms",
          description:
            "List alarms. Accepts optional OData $filter (e.g. \"State eq 'open'\"); if omitted the user is prompted for a state.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 100)", default: 100 },
            },
          },
        },
        {
          name: "kaseya_vsa_list_tickets",
          description:
            "List Service Desk tickets. Returns a friendly message if the Service Desk module is not enabled on the tenant.",
          inputSchema: {
            type: "object",
            properties: {
              filter: { type: "string", description: "OData $filter expression (optional)" },
              top: { type: "number", description: "Max records (default 100)", default: 100 },
            },
          },
        },
        {
          name: "kaseya_vsa_list_organizations",
          description: "List organizations defined in the tenant.",
          inputSchema: {
            type: "object",
            properties: {
              top: { type: "number", description: "Max records (default 250)", default: 250 },
            },
          },
        },
        {
          name: "kaseya_vsa_list_machine_groups",
          description: "List machine groups (organization → group hierarchy).",
          inputSchema: {
            type: "object",
            properties: {
              top: { type: "number", description: "Max records (default 250)", default: 250 },
            },
          },
        },
      ],
    };
  });

  // MCP Apps (SEP-1865): the ui:// device card is static HTML embedded at
  // build time (src/generated/device-card-html.ts), so it serves identically
  // from stdio, Node HTTP, and fs-less runtimes.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: DEVICE_CARD_RESOURCE_URI,
          name: "Kaseya VSA Device Card",
          description: "Interactive MCP Apps card rendering a Kaseya VSA managed endpoint",
          mimeType: MCP_APP_RESOURCE_MIME,
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== DEVICE_CARD_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_RESOURCE_MIME,
          // The card ships neutral; operators brand it at serve time via
          // MCP_BRAND_* env vars (no vars = HTML served unchanged).
          text: applyBrandInjection(DEVICE_CARD_HTML, brandFromEnv()),
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  // Hard cap to keep one tool call from streaming the entire history.
  const RESULT_HARD_CAP = 2000;

  function looksLikeNotFound(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /\b404\b/.test(msg) || /not found/i.test(msg);
  }

  async function resolveAgentFilter(
    provided: string | undefined,
    client: KaseyaVsaClient
  ): Promise<string | undefined> {
    if (provided) return provided;

    const choice = await elicitSelection(
      "No filter provided. Listing every agent in the tenant can be very large. Choose a scope:",
      "scope",
      [
        { value: "__all__", label: "All agents (no filter)" },
        { value: "__org__", label: "Pick an organization" },
        { value: "__custom__", label: "Enter a custom OData $filter" },
      ]
    );

    if (!choice || choice === "__all__") return undefined;

    if (choice === "__custom__") {
      const f = await elicitText(
        "Enter the OData $filter expression (e.g. OrgRef eq 'acme').",
        "filter",
        "OData $filter"
      );
      return f || undefined;
    }

    if (choice === "__org__") {
      try {
        const orgs = await (client as unknown as {
          organizations: { list: () => Promise<unknown> };
        }).organizations.list();
        const items: Array<{ orgRef?: string; orgName?: string; id?: string | number }> = Array.isArray(
          (orgs as { items?: unknown }).items
        )
          ? ((orgs as { items: Array<{ orgRef?: string; orgName?: string; id?: string | number }> }).items)
          : Array.isArray(orgs)
            ? (orgs as Array<{ orgRef?: string; orgName?: string; id?: string | number }>)
            : [];
        if (items.length === 0) return undefined;
        const options = items.slice(0, 25).map((o) => ({
          value: o.orgRef ?? String(o.id ?? ""),
          label: `${o.orgRef ?? o.id ?? ""}${o.orgName ? ` — ${o.orgName}` : ""}`,
        }));
        const picked = await elicitSelection("Select an organization:", "orgRef", options);
        if (!picked) return undefined;
        return `OrgRef eq '${picked.replace(/'/g, "''")}'`;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  async function resolveAlarmFilter(provided: string | undefined): Promise<string | undefined> {
    if (provided) return provided;
    const choice = await elicitSelection(
      "No alarm filter provided. Choose a state to scope this query:",
      "state",
      [
        { value: "open", label: "Open alarms only" },
        { value: "closed", label: "Closed alarms only" },
        { value: "__all__", label: "All alarms" },
        { value: "__custom__", label: "Enter a custom OData $filter" },
      ]
    );
    if (!choice || choice === "__all__") return undefined;
    if (choice === "__custom__") {
      const f = await elicitText(
        "Enter the OData $filter expression.",
        "filter",
        "OData $filter"
      );
      return f || undefined;
    }
    return `State eq '${choice}'`;
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: No API credentials provided. Configure KASEYA_VSA_TENANT_URL plus either (KASEYA_VSA_USERNAME + KASEYA_VSA_PASSWORD) or KASEYA_VSA_K1_TOKEN — or pass them as gateway headers.",
          },
        ],
        isError: true,
      };
    }

    const client = createClient(creds);
    // Cast for SDK calls whose exact signatures may vary; we exercise the
    // documented surface from the design brief and surface real errors.
    type AnyClient = KaseyaVsaClient & Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
    const c = client as unknown as AnyClient;

    try {
      switch (name) {
        case "kaseya_vsa_list_agents": {
          const params = (args ?? {}) as { filter?: string; top?: number; skip?: number };
          const filter = await resolveAgentFilter(params.filter, client);
          const top = Math.min(params.top ?? 100, RESULT_HARD_CAP);
          const result = await c.agents.list({ top, skip: params.skip, filter });
          return { content: [{ type: "text", text: JSON.stringify(result ?? [], null, 2) }] };
        }

        case "kaseya_vsa_get_agent": {
          const { agentId } = args as { agentId: string };
          const agent = await c.agents.get(agentId);
          // MCP Apps: attach the normalized payload the ui:// device card
          // renders from. Best-effort — a null card just means no UI surface.
          const card = buildDeviceCard(agent as Partial<VsaAgent> | undefined);
          const payload = card ? { ...(agent as object), _card: card } : agent;
          if (card) {
            const summary = `${card.name ?? "Agent"}${card.status ? ` is ${card.status}` : ""}${
              card.operatingSystem ? ` (${card.operatingSystem})` : ""
            }.`;
            return {
              content: [{ type: "text", text: summary }],
              structuredContent: payload as Record<string, unknown>,
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(payload ?? {}, null, 2) }] };
        }

        case "kaseya_vsa_get_software_inventory": {
          const { agentId } = args as { agentId: string };
          const sw = await c.audit.listSoftware(agentId);
          return { content: [{ type: "text", text: JSON.stringify(sw ?? [], null, 2) }] };
        }

        case "kaseya_vsa_get_hardware_inventory": {
          const { agentId } = args as { agentId: string };
          const hw = await c.audit.getHardware(agentId);
          return { content: [{ type: "text", text: JSON.stringify(hw ?? {}, null, 2) }] };
        }

        case "kaseya_vsa_get_patch_status": {
          const { agentId } = args as { agentId: string };
          const status = await c.patches.getStatus(agentId);
          return { content: [{ type: "text", text: JSON.stringify(status ?? {}, null, 2) }] };
        }

        case "kaseya_vsa_deploy_patches_now": {
          const { agentId } = args as { agentId: string };
          const ok = await elicitConfirmation(
            `This will immediately deploy pending patches to agent ${agentId}. This action is destructive and cannot be undone. Proceed?`
          );
          if (ok !== true) {
            return {
              content: [{ type: "text", text: "Patch deploy cancelled by user." }],
            };
          }
          const result = await c.patches.deployNow(agentId);
          return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
        }

        case "kaseya_vsa_list_procedures": {
          const { agentId } = args as { agentId: string };
          const procs = await c.procedures.list(agentId);
          return { content: [{ type: "text", text: JSON.stringify(procs ?? [], null, 2) }] };
        }

        case "kaseya_vsa_run_procedure": {
          const { agentId, procedureId } = args as { agentId: string; procedureId: string };
          const ok = await elicitConfirmation(
            `This will execute procedure ${procedureId} on agent ${agentId}. Procedures can make arbitrary system changes. Proceed?`
          );
          if (ok !== true) {
            return {
              content: [{ type: "text", text: "Procedure execution cancelled by user." }],
            };
          }
          const result = await c.procedures.runNow(agentId, procedureId);
          return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
        }

        case "kaseya_vsa_list_alarms": {
          const params = (args ?? {}) as { filter?: string; top?: number };
          const filter = await resolveAlarmFilter(params.filter);
          const top = Math.min(params.top ?? 100, RESULT_HARD_CAP);
          const alarms = await c.alarms.list({ filter, top });
          return { content: [{ type: "text", text: JSON.stringify(alarms ?? [], null, 2) }] };
        }

        case "kaseya_vsa_list_tickets": {
          const params = (args ?? {}) as { filter?: string; top?: number };
          const top = Math.min(params.top ?? 100, RESULT_HARD_CAP);
          try {
            const tickets = await c.tickets.list({ filter: params.filter, top });
            return { content: [{ type: "text", text: JSON.stringify(tickets ?? [], null, 2) }] };
          } catch (err) {
            if (looksLikeNotFound(err)) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Service Desk module does not appear to be enabled on this VSA tenant (received 404). Tickets are unavailable.",
                  },
                ],
              };
            }
            throw err;
          }
        }

        case "kaseya_vsa_list_organizations": {
          const params = (args ?? {}) as { top?: number };
          const top = Math.min(params.top ?? 250, RESULT_HARD_CAP);
          const orgs = await c.organizations.list({ top });
          return { content: [{ type: "text", text: JSON.stringify(orgs ?? [], null, 2) }] };
        }

        case "kaseya_vsa_list_machine_groups": {
          const params = (args ?? {}) as { top?: number };
          const top = Math.min(params.top ?? 250, RESULT_HARD_CAP);
          const mgs = await c.machineGroups.list({ top });
          return { content: [{ type: "text", text: JSON.stringify(mgs ?? [], null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session for the whole process — no concurrent tenants
  // to isolate from each other, so enterWith's process-lifetime binding is
  // safe.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Kaseya VSA MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// HTTP service-to-service auth
// ---------------------------------------------------------------------------

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret. Matched case-insensitively after trim. Never log the value.
 * Unresolved `${...}` manifest placeholders are rejected too.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with openssl rand -hex 32 and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is not enforcing X-Gateway-S2S and is bound to 127.0.0.1 only. " +
  "Do not use this outside local development.";

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder
 * always refuses to start. The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase()) || CONFIG_PLACEHOLDER.test(raw)) {
    console.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(INSECURE_DEV_WARNING);
    return { secret: "", insecureDev: true };
  }
  console.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * With a real secret, honor MCP_HTTP_HOST (default 127.0.0.1 when unset).
 * Without a secret the insecure-dev bypass forces 127.0.0.1, including when
 * MCP_HTTP_HOST is a wider address such as 0.0.0.0.
 */
function resolveBindHost(hasRealSecret: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (hasRealSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET forces the listener to 127.0.0.1 only."
    );
  }
  return LOOPBACK_HOST;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const { secret: s2sSecret, insecureDev } = resolveHttpS2sSecret();
  const host = resolveBindHost(!insecureDev);
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint — unauthenticated liveness. Must not read credentials.
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
      // A configured secret is always enforced, before credential extraction.
      const s2sHeader = headerValue(req.headers[S2S_HEADER]);
      if (s2sSecret && !verifyS2sHeader(s2sHeader, s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // In gateway mode, extract credentials from headers and pass directly
      // to avoid process.env race conditions under concurrent load.
      // Missing headers are rejected. Falling through would resolve
      // KASEYA_VSA_* from the process environment, which is not request-scoped.
      let gatewayCredentials: KaseyaVsaCredentials | undefined;
      if (isGatewayMode) {
        const baseUrl = cleanCredential(headerValue(req.headers["x-kaseya-vsa-tenant-url"]));
        const username = cleanCredential(headerValue(req.headers["x-kaseya-vsa-username"]));
        const password = cleanCredential(headerValue(req.headers["x-kaseya-vsa-password"]));
        const kaseyaOneToken = cleanCredential(headerValue(req.headers["x-kaseya-vsa-k1-token"]));

        const hasLocal = !!(username && password);
        if (!baseUrl || (!hasLocal && !kaseyaOneToken)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires X-Kaseya-VSA-Tenant-Url plus either (X-Kaseya-VSA-Username + X-Kaseya-VSA-Password) or X-Kaseya-VSA-K1-Token.",
              required: [
                "X-Kaseya-VSA-Tenant-Url",
                "(X-Kaseya-VSA-Username + X-Kaseya-VSA-Password) OR X-Kaseya-VSA-K1-Token",
              ],
            })
          );
          return;
        }

        gatewayCredentials = { baseUrl, username, password, kaseyaOneToken };
      }

      // Stateless: fresh server + transport per request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      // The whole chain below (connect through the catch handler) runs
      // inside runWithServerRef so the server-ref binding — used by
      // elicitation (elicitConfirmation/elicitSelection/elicitText) —
      // survives every await gap in this request's lifecycle without
      // leaking into a concurrent request's server-ref.
      runWithServerRef(server, () =>
        server
          .connect(transport as unknown as Transport)
          .then(() => {
            transport.handleRequest(req, res);
          })
          .catch((err) => {
            console.error("MCP transport error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32603, message: "Internal error" },
                  id: null,
                })
              );
            }
          })
      );

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer!.once("error", onError);
    httpServer!.listen(port, host, () => {
      httpServer!.off("error", onError);
      console.error(`Kaseya VSA MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Kaseya VSA MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Guard the bootstrap so importing this module in tests does not start a server
// (vitest sets NODE_ENV=test by default).
if (process.env.NODE_ENV !== "test") {
  main().catch(console.error);
}
