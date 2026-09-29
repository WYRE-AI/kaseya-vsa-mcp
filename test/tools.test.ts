/**
 * Handler-invocation tests for the tool call dispatcher in src/index.ts.
 *
 * Replaces the "Tool Definitions" / "Credentials" / "Server Configuration"
 * blocks of test/index.test.ts, which asserted only against locally-declared
 * literal arrays/objects and never touched the real server (the issue #73
 * regression block in that file is real and stays as-is). Drives the real
 * Server over a linked in-memory transport (same pattern as
 * test/mcp-apps.test.ts), mocking @wyre-technology/node-kaseya-vsa so each
 * test asserts the exact outbound call shape and response transformation --
 * for every tool except kaseya_vsa_get_agent, whose request/response shape
 * (including the _card payload) is already covered by test/mcp-apps.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/index.js";
import { bindServerRef } from "../src/utils/server-ref.js";

const {
  mockAgentsList,
  mockAgentsGet,
  mockListSoftware,
  mockGetHardware,
  mockGetStatus,
  mockDeployNow,
  mockProceduresList,
  mockRunNow,
  mockAlarmsList,
  mockTicketsList,
  mockOrganizationsList,
  mockMachineGroupsList,
} = vi.hoisted(() => ({
  mockAgentsList: vi.fn(),
  mockAgentsGet: vi.fn(),
  mockListSoftware: vi.fn(),
  mockGetHardware: vi.fn(),
  mockGetStatus: vi.fn(),
  mockDeployNow: vi.fn(),
  mockProceduresList: vi.fn(),
  mockRunNow: vi.fn(),
  mockAlarmsList: vi.fn(),
  mockTicketsList: vi.fn(),
  mockOrganizationsList: vi.fn(),
  mockMachineGroupsList: vi.fn(),
}));

vi.mock("@wyre-technology/node-kaseya-vsa", () => ({
  KaseyaVsaClient: class {
    agents = { list: mockAgentsList, get: mockAgentsGet };
    audit = { listSoftware: mockListSoftware, getHardware: mockGetHardware };
    patches = { getStatus: mockGetStatus, deployNow: mockDeployNow };
    procedures = { list: mockProceduresList, runNow: mockRunNow };
    alarms = { list: mockAlarmsList };
    tickets = { list: mockTicketsList };
    organizations = { list: mockOrganizationsList };
    machineGroups = { list: mockMachineGroupsList };
  },
}));

const ALL_MOCKS = [
  mockAgentsList,
  mockAgentsGet,
  mockListSoftware,
  mockGetHardware,
  mockGetStatus,
  mockDeployNow,
  mockProceduresList,
  mockRunNow,
  mockAlarmsList,
  mockTicketsList,
  mockOrganizationsList,
  mockMachineGroupsList,
];

const CREDS = { baseUrl: "https://vsa.example.com/api/v1.0", username: "svc", password: "pass" };

async function connectClient(
  creds?: { baseUrl: string; username?: string; password?: string; kaseyaOneToken?: string }
): Promise<Client> {
  // Bind the server ref exactly like the real stdio/HTTP entrypoints do, so
  // "elicitation unavailable" tests exercise the real reason it's
  // unavailable -- the connected client not declaring the capability --
  // rather than accidentally testing a ref that was never bound at all.
  const server = createMcpServer(creds);
  bindServerRef(server);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

type ElicitResponse = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/**
 * A Client that declares elicitation support. `response` is either a single
 * fixed answer for every prompt, or a function keyed on the requested
 * field's name -- needed for a multi-step flow like resolveAgentFilter's
 * org picker, which asks two different questions ("scope" then "orgRef")
 * in sequence and needs a different answer for each.
 */
async function connectElicitingClient(
  creds: { baseUrl: string; username?: string; password?: string; kaseyaOneToken?: string },
  response: ElicitResponse | ((fieldName: string) => ElicitResponse)
): Promise<Client> {
  const server = createMcpServer(creds);
  bindServerRef(server);
  const client = new Client(
    { name: "test-host", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    if (typeof response === "function") {
      const fieldName = Object.keys(request.params.requestedSchema.properties)[0];
      return response(fieldName);
    }
    return response;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function text(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const m of ALL_MOCKS) m.mockReset();
});

describe("tool surface", () => {
  it("exposes exactly the 12 documented tools", async () => {
    const client = await connectClient(CREDS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "kaseya_vsa_list_agents",
        "kaseya_vsa_get_agent",
        "kaseya_vsa_get_software_inventory",
        "kaseya_vsa_get_hardware_inventory",
        "kaseya_vsa_get_patch_status",
        "kaseya_vsa_deploy_patches_now",
        "kaseya_vsa_list_procedures",
        "kaseya_vsa_run_procedure",
        "kaseya_vsa_list_alarms",
        "kaseya_vsa_list_tickets",
        "kaseya_vsa_list_organizations",
        "kaseya_vsa_list_machine_groups",
      ].sort()
    );
  });
});

describe("missing credentials", () => {
  it("returns an isError result instead of calling the API client", async () => {
    vi.stubEnv("KASEYA_VSA_TENANT_URL", "");
    const client = await connectClient();
    const result = (await client.callTool({
      name: "kaseya_vsa_list_agents",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No API credentials provided/);
    expect(mockAgentsList).not.toHaveBeenCalled();
  });
});

describe("kaseya_vsa_list_agents", () => {
  it("defaults top to 100 with no filter/skip when elicitation is unavailable", async () => {
    mockAgentsList.mockResolvedValue([{ AgentId: "a1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_agents",
      arguments: {},
    })) as ToolResult;
    expect(mockAgentsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: undefined });
    expect(JSON.parse(text(result))).toEqual([{ AgentId: "a1" }]);
  });

  it("forwards an explicit filter without prompting", async () => {
    mockAgentsList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "kaseya_vsa_list_agents",
      arguments: { filter: "OrgRef eq 'acme'", skip: 10 },
    });
    expect(mockAgentsList).toHaveBeenCalledWith({ top: 100, skip: 10, filter: "OrgRef eq 'acme'" });
  });

  it("caps top at the 2000 hard cap", async () => {
    mockAgentsList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "kaseya_vsa_list_agents",
      arguments: { filter: "x", top: 50000 },
    });
    expect(mockAgentsList).toHaveBeenCalledWith({ top: 2000, skip: undefined, filter: "x" });
  });

  it("lists organizations and builds an OrgRef filter when the user picks an org", async () => {
    mockOrganizationsList.mockResolvedValue([{ orgRef: "acme", orgName: "Acme Corp" }]);
    mockAgentsList.mockResolvedValue([]);
    // Two different questions get asked in sequence (scope, then orgRef) --
    // answer each by its field name so this actually exercises a real pick,
    // not just the picker branch being entered.
    const client = await connectElicitingClient(CREDS, (fieldName) =>
      fieldName === "scope"
        ? { action: "accept", content: { scope: "__org__" } }
        : { action: "accept", content: { orgRef: "acme" } }
    );
    await client.callTool({ name: "kaseya_vsa_list_agents", arguments: {} });
    expect(mockOrganizationsList).toHaveBeenCalled();
    expect(mockAgentsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: "OrgRef eq 'acme'" });
  });

  it("returns no filter when the org picker is entered but nothing gets picked", async () => {
    mockOrganizationsList.mockResolvedValue([{ orgRef: "acme", orgName: "Acme Corp" }]);
    mockAgentsList.mockResolvedValue([]);
    // A fixed responder that only answers the first ("scope") question
    // leaves the second ("orgRef") prompt's content field absent, which is
    // exactly what a client declining/ignoring the second prompt looks like.
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { scope: "__org__" } });
    await client.callTool({ name: "kaseya_vsa_list_agents", arguments: {} });
    expect(mockOrganizationsList).toHaveBeenCalled();
    expect(mockAgentsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: undefined });
  });
});

describe("kaseya_vsa_get_agent", () => {
  it("calls agents.get with the exact agent id", async () => {
    mockAgentsGet.mockResolvedValue({ AgentId: "a1" });
    const client = await connectClient(CREDS);
    await client.callTool({ name: "kaseya_vsa_get_agent", arguments: { agentId: "a1" } });
    expect(mockAgentsGet).toHaveBeenCalledWith("a1");
  });
});

describe("kaseya_vsa_get_software_inventory", () => {
  it("calls audit.listSoftware with the exact agent id", async () => {
    mockListSoftware.mockResolvedValue([{ name: "Chrome" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_get_software_inventory",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(mockListSoftware).toHaveBeenCalledWith("a1");
    expect(JSON.parse(text(result))).toEqual([{ name: "Chrome" }]);
  });
});

describe("kaseya_vsa_get_hardware_inventory", () => {
  it("calls audit.getHardware with the exact agent id", async () => {
    mockGetHardware.mockResolvedValue({ cpu: "x64" });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_get_hardware_inventory",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(mockGetHardware).toHaveBeenCalledWith("a1");
    expect(JSON.parse(text(result))).toEqual({ cpu: "x64" });
  });
});

describe("kaseya_vsa_get_patch_status", () => {
  it("calls patches.getStatus with the exact agent id", async () => {
    mockGetStatus.mockResolvedValue({ pending: 3 });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_get_patch_status",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(mockGetStatus).toHaveBeenCalledWith("a1");
    expect(JSON.parse(text(result))).toEqual({ pending: 3 });
  });

  it("returns an isError result instead of throwing when the client rejects", async () => {
    mockGetStatus.mockRejectedValue(new Error("upstream 500"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_get_patch_status",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: upstream 500");
  });
});

describe("kaseya_vsa_deploy_patches_now", () => {
  it("deploys when the user confirms", async () => {
    mockDeployNow.mockResolvedValue({ ok: true });
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: true } });
    const result = (await client.callTool({
      name: "kaseya_vsa_deploy_patches_now",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(mockDeployNow).toHaveBeenCalledWith("a1");
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ ok: true });
  });

  it("cancels without calling the client and without isError when the user declines", async () => {
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: false } });
    const result = (await client.callTool({
      name: "kaseya_vsa_deploy_patches_now",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    // Unlike the sibling repos' destructive-restore tools, this handler does
    // NOT set isError on cancellation -- pin that exactly, not what might be
    // assumed from the pattern seen elsewhere.
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Patch deploy cancelled by user.");
    expect(mockDeployNow).not.toHaveBeenCalled();
  });

  it("cancels without calling the client when confirmation is unsupported", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_deploy_patches_now",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Patch deploy cancelled by user.");
    expect(mockDeployNow).not.toHaveBeenCalled();
  });
});

describe("kaseya_vsa_list_procedures", () => {
  it("calls procedures.list with the exact agent id", async () => {
    mockProceduresList.mockResolvedValue([{ id: "p1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_procedures",
      arguments: { agentId: "a1" },
    })) as ToolResult;
    expect(mockProceduresList).toHaveBeenCalledWith("a1");
    expect(JSON.parse(text(result))).toEqual([{ id: "p1" }]);
  });
});

describe("kaseya_vsa_run_procedure", () => {
  it("runs the procedure when the user confirms", async () => {
    mockRunNow.mockResolvedValue({ status: "started" });
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: true } });
    const result = (await client.callTool({
      name: "kaseya_vsa_run_procedure",
      arguments: { agentId: "a1", procedureId: "p1" },
    })) as ToolResult;
    expect(mockRunNow).toHaveBeenCalledWith("a1", "p1");
    expect(JSON.parse(text(result))).toEqual({ status: "started" });
  });

  it("cancels without calling the client when the user declines", async () => {
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: false } });
    const result = (await client.callTool({
      name: "kaseya_vsa_run_procedure",
      arguments: { agentId: "a1", procedureId: "p1" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Procedure execution cancelled by user.");
    expect(mockRunNow).not.toHaveBeenCalled();
  });
});

describe("kaseya_vsa_list_alarms", () => {
  it("forwards an explicit filter without prompting", async () => {
    mockAlarmsList.mockResolvedValue([{ id: "al1" }]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "kaseya_vsa_list_alarms",
      arguments: { filter: "State eq 'open'" },
    });
    expect(mockAlarmsList).toHaveBeenCalledWith({ filter: "State eq 'open'", top: 100 });
  });

  it("defaults to no filter when omitted and elicitation is unavailable", async () => {
    mockAlarmsList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({ name: "kaseya_vsa_list_alarms", arguments: {} });
    expect(mockAlarmsList).toHaveBeenCalledWith({ filter: undefined, top: 100 });
  });

  it("builds a State filter from a preset choice when elicitation is available", async () => {
    mockAlarmsList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { state: "open" } });
    await client.callTool({ name: "kaseya_vsa_list_alarms", arguments: {} });
    expect(mockAlarmsList).toHaveBeenCalledWith({ filter: "State eq 'open'", top: 100 });
  });
});

describe("kaseya_vsa_list_tickets", () => {
  it("returns tickets on success", async () => {
    mockTicketsList.mockResolvedValue([{ id: "t1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_tickets",
      arguments: {},
    })) as ToolResult;
    expect(mockTicketsList).toHaveBeenCalledWith({ filter: undefined, top: 100 });
    expect(JSON.parse(text(result))).toEqual([{ id: "t1" }]);
  });

  it("returns a friendly message (not isError) when the module is disabled (404)", async () => {
    mockTicketsList.mockRejectedValue(new Error("Request failed with status 404"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_tickets",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/Service Desk module does not appear to be enabled/);
  });

  it("returns an isError result for a non-404 failure instead of the friendly message", async () => {
    mockTicketsList.mockRejectedValue(new Error("upstream 500"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_tickets",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: upstream 500");
  });
});

describe("kaseya_vsa_list_organizations", () => {
  it("defaults top to 250 and caps at the hard cap", async () => {
    mockOrganizationsList.mockResolvedValue([{ orgRef: "acme" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_organizations",
      arguments: {},
    })) as ToolResult;
    expect(mockOrganizationsList).toHaveBeenCalledWith({ top: 250 });
    expect(JSON.parse(text(result))).toEqual([{ orgRef: "acme" }]);

    mockOrganizationsList.mockClear();
    await client.callTool({ name: "kaseya_vsa_list_organizations", arguments: { top: 999999 } });
    expect(mockOrganizationsList).toHaveBeenCalledWith({ top: 2000 });
  });
});

describe("kaseya_vsa_list_machine_groups", () => {
  it("defaults top to 250", async () => {
    mockMachineGroupsList.mockResolvedValue([{ id: "mg1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_list_machine_groups",
      arguments: {},
    })) as ToolResult;
    expect(mockMachineGroupsList).toHaveBeenCalledWith({ top: 250 });
    expect(JSON.parse(text(result))).toEqual([{ id: "mg1" }]);
  });
});

describe("unknown tool", () => {
  it("returns an isError result naming the unknown tool", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_vsa_not_a_real_tool",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool: kaseya_vsa_not_a_real_tool");
  });
});
