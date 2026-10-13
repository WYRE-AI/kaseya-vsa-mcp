/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are rejected even with that flag. The flag forces the
 * listener onto 127.0.0.1. A configured secret honors MCP_HTTP_HOST.
 * AUTH_MODE=gateway rejects /mcp requests that omit X-Kaseya-VSA-* credential
 * headers and must not fall back to KASEYA_VSA_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { constructedClients } = vi.hoisted(() => ({
  constructedClients: [] as Array<Record<string, unknown>>,
}));

vi.mock("@wyre-technology/node-kaseya-vsa", () => ({
  KaseyaVsaClient: class {
    constructor(opts: Record<string, unknown>) {
      constructedClients.push(opts);
    }
    organizations = { list: async () => [] };
  },
}));

import { startHttpTransport } from "../index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_TENANT = "https://env.example.com/api/v1.0";
const ENV_USERNAME = "env-user-must-not-be-used";
const ENV_PASSWORD = "env-password-must-not-be-used";
const ENV_K1 = "env-k1-token-must-not-be-used";
const HEADER_TENANT = "https://header.example.com/api/v1.0";
const HEADER_USERNAME = "header-user";
const HEADER_PASSWORD = "header-password-do-not-log";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "KASEYA_VSA_TENANT_URL",
  "KASEYA_VSA_USERNAME",
  "KASEYA_VSA_PASSWORD",
  "KASEYA_VSA_K1_TOKEN",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  }).then(async (response) => ({
    status: response.status,
    body: await response.text(),
  }));
}

async function listen(): Promise<{ port: number; address: string }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address() as AddressInfo | string | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const orgCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "kaseya_vsa_list_organizations", arguments: {} },
});

function assertNoSecrets(text: string, extra: string[] = []): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_PASSWORD);
  expect(text).not.toContain(ENV_K1);
  expect(text).not.toContain(HEADER_PASSWORD);
  expect(text).not.toContain(ENV_USERNAME);
  for (const value of extra) {
    expect(text).not.toContain(value);
  }
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.KASEYA_VSA_TENANT_URL;
  delete process.env.KASEYA_VSA_USERNAME;
  delete process.env.KASEYA_VSA_PASSWORD;
  delete process.env.KASEYA_VSA_K1_TOKEN;
  constructedClients.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      assertNoSecrets(text);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
      assertNoSecrets(logs.text());
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each(["changeme", "replace-with-a-real-secret", "  Your-S2S-Secret  ", "${user_config.conduit_s2s_secret}"])(
    "refuses known placeholder %j even when MCP_ALLOW_INSECURE_DEV=1",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = "0.0.0.0";
      const logs = captureStderr();
      const exit = exitSpy();
      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain(placeholder.trim());
        assertNoSecrets(text);
      } finally {
        exit.mockRestore();
        logs.restore();
      }
    },
  );

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("127.0.0.1");
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      try {
        const server = await listen();
        expect(server.address).toBe("127.0.0.1");
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain("forces the listener to 127.0.0.1 only");
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).toContain("SECURITY WARNING");
      expect(logs.text()).not.toContain("is not a loopback address");
    } finally {
      logs.restore();
    }
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not a loopback address");
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.KASEYA_VSA_TENANT_URL = ENV_TENANT;
    process.env.KASEYA_VSA_USERNAME = ENV_USERNAME;
    process.env.KASEYA_VSA_PASSWORD = ENV_PASSWORD;
    process.env.KASEYA_VSA_K1_TOKEN = ENV_K1;
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-kaseya-vsa-tenant-url": HEADER_TENANT,
          "x-kaseya-vsa-username": HEADER_USERNAME,
          "x-kaseya-vsa-password": HEADER_PASSWORD,
        }),
        body: orgCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
          "x-kaseya-vsa-tenant-url": HEADER_TENANT,
          "x-kaseya-vsa-username": HEADER_USERNAME,
          "x-kaseya-vsa-password": HEADER_PASSWORD,
        }),
        body: orgCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(constructedClients).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: orgCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("Missing credentials");
    expect(response.body).toContain("X-Kaseya-VSA-Tenant-Url");
    assertNoSecrets(response.body, [ENV_TENANT]);
    expect(constructedClients).toEqual([]);

    const partial = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-kaseya-vsa-tenant-url": HEADER_TENANT,
        "x-kaseya-vsa-username": HEADER_USERNAME,
      }),
      body: orgCall,
    });
    expect(partial.status).toBe(401);
    expect(partial.body).toContain("Missing credentials");
    expect(constructedClients).toEqual([]);
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-kaseya-vsa-tenant-url": HEADER_TENANT,
          "x-kaseya-vsa-username": HEADER_USERNAME,
          "x-kaseya-vsa-password": HEADER_PASSWORD,
        }),
        body: orgCall,
      });

      expect(response.status).toBe(200);
      assertNoSecrets(response.body, [ENV_TENANT]);
      assertNoSecrets(logs.text());
      expect(constructedClients).toEqual([
        {
          baseUrl: HEADER_TENANT,
          username: HEADER_USERNAME,
          password: HEADER_PASSWORD,
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  it("accepts a Kaseya One token header without username or password", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-kaseya-vsa-tenant-url": HEADER_TENANT,
        "x-kaseya-vsa-k1-token": "header-k1-token",
      }),
      body: orgCall,
    });

    expect(response.status).toBe(200);
    expect(response.body).not.toContain(ENV_K1);
    expect(constructedClients).toEqual([
      {
        baseUrl: HEADER_TENANT,
        kaseyaOneToken: "header-k1-token",
      },
    ]);
  });

  it("does not require vendor credential headers in env mode after S2S auth", async () => {
    process.env.AUTH_MODE = "env";
    // A Kaseya One token in the environment is preferred over username/password.
    // Drop it so this case asserts the local-auth env path.
    delete process.env.KASEYA_VSA_K1_TOKEN;
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: orgCall,
    });

    expect(response.status).toBe(200);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(constructedClients).toEqual([
      {
        baseUrl: ENV_TENANT,
        username: ENV_USERNAME,
        password: ENV_PASSWORD,
      },
    ]);
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "GET",
      path: "/health",
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; authMode?: string };
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
    assertNoSecrets(response.body, [ENV_TENANT]);
    expect(constructedClients).toEqual([]);
  });
});
