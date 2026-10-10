import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  resolveAgyMcpConfigPath,
  resolveUniqueMcpServerName,
  writePaperclipAgyMcpConfig,
  stageAgyMcpConfigForSync,
} from "./mcp.js";

describe("resolveAgyMcpConfigPath", () => {
  it("resolves to ~/.gemini/config/mcp_config.json based on homedir", () => {
    const configPath = resolveAgyMcpConfigPath("/custom/home", {});
    expect(configPath).toBe(path.join("/custom/home", ".gemini", "config", "mcp_config.json"));
  });

  it("prefers env.HOME when present", () => {
    const configPath = resolveAgyMcpConfigPath("/fallback/home", { HOME: "/env/home" });
    expect(configPath).toBe(path.join("/env/home", ".gemini", "config", "mcp_config.json"));
  });
});

describe("resolveUniqueMcpServerName", () => {
  it("uses server.name when there is no conflict", () => {
    const server: AdapterRuntimeMcpServer = {
      name: "Paperclip connections",
      url: "https://example.com/mcp",
      token: "secret",
      connectionId: "conn-12345678",
    };
    expect(resolveUniqueMcpServerName(server, new Set())).toBe("Paperclip connections");
  });

  it("appends connectionId slice on conflict", () => {
    const server: AdapterRuntimeMcpServer = {
      name: "github",
      url: "https://example.com/mcp",
      token: "secret",
      connectionId: "conn-12345678",
    };
    const existing = new Set(["github"]);
    expect(resolveUniqueMcpServerName(server, existing)).toBe("github-conn-123");
  });

  it("appends incremental counter on multiple collisions", () => {
    const server: AdapterRuntimeMcpServer = {
      name: "github",
      url: "https://example.com/mcp",
      token: "secret",
      connectionId: "conn-12345678",
    };
    const existing = new Set(["github", "github-conn-123"]);
    expect(resolveUniqueMcpServerName(server, existing)).toBe("github-conn-123-2");
  });
});

describe("writePaperclipAgyMcpConfig", () => {
  it("creates mcp_config.json and cleans up when no prior file existed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "Paperclip connections",
        url: "https://api.paperclip.test/mcp/connections",
        token: "tok-abc",
        connectionId: "conn-1",
      },
      {
        name: "Paperclip projects",
        url: "https://api.paperclip.test/mcp/projects",
        token: "",
        connectionId: "conn-2",
      },
    ];

    try {
      const result = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers,
        runId: "run-1",
      });

      expect(result.injectedServerNames).toEqual(["Paperclip connections", "Paperclip projects"]);
      expect(result.configPath).toBe(path.join(tempDir, ".gemini", "config", "mcp_config.json"));

      const content = JSON.parse(await fs.readFile(result.configPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer tok-abc" },
      });
      expect(content.mcpServers["Paperclip projects"]).toEqual({
        url: "https://api.paperclip.test/mcp/projects",
      });

      await result.cleanup();

      // Since file was created from scratch and now empty, it should be deleted
      const exists = await fs.stat(result.configPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves unmanaged user MCP servers before, during, and after cleanup", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const configDir = path.join(tempDir, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp_config.json");

    const initialConfig = {
      mcpServers: {
        codegraph: {
          command: "codegraph",
          args: ["serve", "--mcp"],
        },
        custom_http: {
          url: "https://custom.tool/mcp",
        },
      },
      otherSettings: { enabled: true },
    };
    await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "codegraph",
        url: "https://api.paperclip.test/mcp/gateways/codegraph",
        token: "gw-token",
        connectionId: "cg-conn-12345",
      },
    ];

    try {
      const result = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers,
      });

      // Avoided collision with pre-existing "codegraph"
      expect(result.injectedServerNames).toEqual(["codegraph-cg-conn-"]);

      const content = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(content.mcpServers.codegraph).toEqual(initialConfig.mcpServers.codegraph);
      expect(content.mcpServers.custom_http).toEqual(initialConfig.mcpServers.custom_http);
      expect(content.mcpServers["codegraph-cg-conn-"]).toEqual({
        url: "https://api.paperclip.test/mcp/gateways/codegraph",
        headers: { Authorization: "Bearer gw-token" },
      });
      expect(content.otherSettings).toEqual({ enabled: true });

      await result.cleanup();

      const afterCleanup = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(afterCleanup.mcpServers.codegraph).toEqual(initialConfig.mcpServers.codegraph);
      expect(afterCleanup.mcpServers.custom_http).toEqual(initialConfig.mcpServers.custom_http);
      expect(afterCleanup.mcpServers["codegraph-cg-conn-"]).toBeUndefined();
      expect(afterCleanup.otherSettings).toEqual({ enabled: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("stageAgyMcpConfigForSync", () => {
  it("stages Paperclip MCP servers into a private directory with mcp_config.json", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-home-"));
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "Paperclip connections",
        url: "https://api.paperclip.test/mcp/connections",
        token: "tok-123",
        connectionId: "conn-1",
      },
    ];

    const stagedDir = await stageAgyMcpConfigForSync({
      homedir: tempHome,
      servers,
      runId: "run-mcp-sync-1",
    });

    try {
      const stagedConfigPath = path.join(stagedDir, "mcp_config.json");
      const exists = await fs.stat(stagedConfigPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      const content = JSON.parse(await fs.readFile(stagedConfigPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer tok-123" },
      });
    } finally {
      await Promise.all([
        fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });

  it("merges existing host MCP servers when staging for sync", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-home-"));
    const configDir = path.join(tempHome, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          existing_tool: { url: "https://existing.tool/mcp" },
        },
      }),
    );

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "paperclip_tool",
        url: "https://api.paperclip.test/mcp/tool",
        token: "",
        connectionId: "conn-2",
      },
    ];

    const stagedDir = await stageAgyMcpConfigForSync({
      homedir: tempHome,
      servers,
      runId: "run-mcp-sync-2",
    });

    try {
      const content = JSON.parse(await fs.readFile(path.join(stagedDir, "mcp_config.json"), "utf8"));
      expect(content.mcpServers.existing_tool).toEqual({ url: "https://existing.tool/mcp" });
      expect(content.mcpServers.paperclip_tool).toEqual({ url: "https://api.paperclip.test/mcp/tool" });
    } finally {
      await Promise.all([
        fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });
});
