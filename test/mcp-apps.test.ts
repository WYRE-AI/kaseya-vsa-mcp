/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the device card:
 *   1. renderable tools advertise the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. kaseya_vsa_get_agent results carry the normalized `_card` payload the
 *      iframe renders from
 *
 * Wire-level checks drive the real Server over an in-memory transport pair
 * (the same request-handler ladder as production); buildDeviceCard is
 * unit-tested directly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";
import {
  applyBrandInjection,
  brandFromEnv,
  buildDeviceCard,
  DEVICE_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../src/device-card.js";
import { DEVICE_CARD_HTML } from "../src/generated/device-card-html.js";

const mockAgentsGet = vi.fn();

vi.mock("@wyre-technology/node-kaseya-vsa", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@wyre-technology/node-kaseya-vsa")>();
  return {
    ...actual,
    KaseyaVsaClient: class {
      agents = { get: mockAgentsGet };
    },
  };
});

async function connect(): Promise<Client> {
  const server = createMcpServer({
    baseUrl: "https://vsa.example.com/api/v1.0",
    username: "user",
    password: "pass",
  });
  const client = new Client({ name: "mcp-apps-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

const RENDERABLE_TOOLS = ["kaseya_vsa_get_agent"];

const onlineAgent = {
  AgentId: "281474976712345",
  AgentName: "srv-dc01.acme",
  ComputerName: "SRV-DC01",
  MachineGroup: "servers.acme",
  Organization: "Acme Corp",
  OperatingSystem: "Windows Server 2022",
  OSVersion: "21H2",
  IPAddress: "10.0.0.5",
  LastCheckin: "2026-07-17T09:00:00Z",
  Online: true,
};

describe("MCP Apps device card", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockAgentsGet.mockReset();
  });

  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const client = await connect();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(DEVICE_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        DEVICE_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const others = tools.filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", async () => {
      const client = await connect();
      const { resources } = await client.listResources();
      const card = resources.find((r) => r.uri === DEVICE_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", async () => {
      const client = await connect();
      const { contents } = await client.readResource({
        uri: DEVICE_CARD_RESOURCE_URI,
      });
      const content = contents[0];
      expect(content?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content?.text).toBe(DEVICE_CARD_HTML);
      expect(content?.text).toContain("card__bar");
      expect(content?.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content?.text).not.toContain('src="./device-card.ts"');
    });

    it("default bundle is brand-neutral (published server — no baked-in identity)", () => {
      expect(DEVICE_CARD_HTML).not.toMatch(/WYRE/i);
      expect(DEVICE_CARD_HTML).not.toContain("fonts.googleapis.com");
      expect(DEVICE_CARD_HTML).not.toContain("https://fonts");
    });

    it("injects MCP_BRAND_* env branding at serve time", async () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      const client = await connect();
      const { contents } = await client.readResource({
        uri: DEVICE_CARD_RESOURCE_URI,
      });
      const text = String(contents[0]?.text ?? "");
      expect(text).toContain('window.__BRAND__={"name":"Acme MSP"}');
      expect(text).not.toContain("BRAND_INJECT");
    });

    it("rejects unknown resource URIs", async () => {
      const client = await connect();
      await expect(
        client.readResource({ uri: "ui://kaseya-vsa/nope.html" })
      ).rejects.toThrow(/Unknown resource/);
    });
  });

  describe("kaseya_vsa_get_agent result", () => {
    it("carries the normalized _card payload in structuredContent, with a plain-text summary in content", async () => {
      mockAgentsGet.mockResolvedValue(onlineAgent);
      const client = await connect();
      const result = await client.callTool({
        name: "kaseya_vsa_get_agent",
        arguments: { agentId: onlineAgent.AgentId },
      });
      expect(result.isError).toBeFalsy();
      // content is a short human-readable summary, not a JSON dump.
      const [first] = result.content as Array<{ type: string; text: string }>;
      expect(first.text).not.toMatch(/^[{[]/);
      expect(first.text).toContain("srv-dc01.acme");
      expect(first.text).toContain("Online");
      // structuredContent carries the model-visible payload plus the card.
      const payload = result.structuredContent as Record<string, unknown>;
      expect(payload.AgentId).toBe(onlineAgent.AgentId);
      expect(payload.AgentName).toBe(onlineAgent.AgentName);
      expect(payload._card).toEqual({
        agentId: "281474976712345",
        name: "srv-dc01.acme",
        computerName: "SRV-DC01",
        status: "Online",
        operatingSystem: "Windows Server 2022 21H2",
        ipAddress: "10.0.0.5",
        organization: "Acme Corp",
        machineGroup: "servers.acme",
        lastCheckin: "2026-07-17T09:00:00Z",
      });
    });

    it("returns the raw payload without _card or structuredContent when the agent is unrecognizable", async () => {
      mockAgentsGet.mockResolvedValue({ unexpected: "shape" });
      const client = await connect();
      const result = await client.callTool({
        name: "kaseya_vsa_get_agent",
        arguments: { agentId: "x" },
      });
      expect(result.structuredContent).toBeUndefined();
      const [first] = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(first.text);
      expect(payload).toEqual({ unexpected: "shape" });
    });
  });

  describe("applyBrandInjection", () => {
    it("replaces the BRAND_INJECT marker with a window.__BRAND__ script", () => {
      const out = applyBrandInjection(DEVICE_CARD_HTML, {
        name: "Acme MSP",
        primaryColor: "#ff0000",
      });
      expect(out).not.toContain("BRAND_INJECT");
      expect(out).toContain(
        'window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}'
      );
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(DEVICE_CARD_HTML, {
        name: "</script><script>alert(1)",
      });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script");
    });

    it("returns the HTML byte-identical for an empty brand", () => {
      expect(applyBrandInjection(DEVICE_CARD_HTML, {})).toBe(DEVICE_CARD_HTML);
      expect(applyBrandInjection(DEVICE_CARD_HTML, { name: "" })).toBe(
        DEVICE_CARD_HTML
      );
    });
  });

  describe("brandFromEnv", () => {
    it("maps MCP_BRAND_* vars and ignores everything else", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#123456");
      expect(brandFromEnv()).toEqual({
        name: "Acme MSP",
        primaryColor: "#123456",
      });
    });

    it("returns an empty brand when nothing is configured", () => {
      expect(brandFromEnv()).toEqual({});
    });
  });

  describe("buildDeviceCard", () => {
    it("prefers AgentName and keeps a distinct ComputerName", () => {
      const card = buildDeviceCard(onlineAgent);
      expect(card?.name).toBe("srv-dc01.acme");
      expect(card?.computerName).toBe("SRV-DC01");
    });

    it("falls back to ComputerName, then a generic label", () => {
      expect(
        buildDeviceCard({ AgentId: "1", ComputerName: "WS-042" })?.name
      ).toBe("WS-042");
      expect(buildDeviceCard({ AgentId: "1" })?.name).toBe("Agent 1");
    });

    it("resolves the Online flag into a status label", () => {
      expect(buildDeviceCard(onlineAgent)?.status).toBe("Online");
      expect(buildDeviceCard({ ...onlineAgent, Online: false })?.status).toBe(
        "Offline"
      );
      expect(
        buildDeviceCard({ AgentId: "1" })?.status
      ).toBeUndefined();
    });

    it("drops unparseable check-in timestamps", () => {
      const card = buildDeviceCard({ ...onlineAgent, LastCheckin: "not-a-date" });
      expect(card?.lastCheckin).toBeUndefined();
    });

    it("accepts numeric agent IDs", () => {
      expect(buildDeviceCard({ AgentId: 42 })?.agentId).toBe("42");
    });

    it("returns null for payloads that are not an agent", () => {
      expect(buildDeviceCard(undefined)).toBeNull();
      expect(buildDeviceCard(null)).toBeNull();
      expect(buildDeviceCard({} as never)).toBeNull();
      expect(buildDeviceCard({ AgentId: "" })).toBeNull();
    });

    it("survives sparse agents (card is best-effort)", () => {
      const card = buildDeviceCard({ AgentId: "abc" });
      expect(card).toEqual({ agentId: "abc", name: "Agent abc" });
    });
  });
});
