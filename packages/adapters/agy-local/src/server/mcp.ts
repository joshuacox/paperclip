import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

export interface AgyMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface AgyMcpConfigFile {
  mcpServers?: Record<string, AgyMcpServerConfig>;
  [key: string]: unknown;
}

export interface WriteAgyMcpConfigInput {
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  servers: AdapterRuntimeMcpServer[];
  runId?: string;
}

export interface WriteAgyMcpConfigResult {
  configPath: string;
  injectedServerNames: string[];
  cleanup: () => Promise<void>;
}

/**
 * Resolves the path to the Antigravity mcp_config.json file.
 * Defaults to $HOME/.gemini/config/mcp_config.json.
 */
export function resolveAgyMcpConfigPath(
  homedir?: string,
  env?: NodeJS.ProcessEnv,
): string {
  const baseHome = env?.HOME || homedir || process.env.HOME || os.homedir();
  return path.join(baseHome, ".gemini", "config", "mcp_config.json");
}

/**
 * Normalizes an MCP server name to prevent naming collisions while preserving readability.
 */
export function resolveUniqueMcpServerName(
  server: AdapterRuntimeMcpServer,
  existingNames: Set<string>,
): string {
  let name = server.name.trim() || "paperclip-tool";
  if (existingNames.has(name)) {
    const connSuffix = server.connectionId ? `-${server.connectionId.slice(0, 8)}` : "";
    name = `${name}${connSuffix}`;
  }
  let suffix = 2;
  const baseName = name;
  while (existingNames.has(name)) {
    name = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return name;
}

/**
 * Writes Paperclip-managed MCP servers to Antigravity's mcp_config.json,
 * preserving existing user-configured servers, and returns a cleanup function
 * that safely removes only the injected servers after the run.
 */
export async function writePaperclipAgyMcpConfig(
  input: WriteAgyMcpConfigInput,
): Promise<WriteAgyMcpConfigResult> {
  const configPath = resolveAgyMcpConfigPath(input.homedir, input.env);
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

  let fileExistedBefore = false;
  let parsedConfig: AgyMcpConfigFile = {};

  try {
    const raw = await fs.readFile(configPath, "utf8");
    if (raw.trim().length > 0) {
      fileExistedBefore = true;
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsedConfig = json;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // If parsing failed or invalid on non-empty file, treat as having existed
      fileExistedBefore = true;
    }
  }

  const existingServers: Record<string, AgyMcpServerConfig> =
    parsedConfig.mcpServers && typeof parsedConfig.mcpServers === "object" && !Array.isArray(parsedConfig.mcpServers)
      ? { ...parsedConfig.mcpServers }
      : {};

  const existingNames = new Set(Object.keys(existingServers));
  const injectedServerNames: string[] = [];

  for (const server of input.servers) {
    const uniqueName = resolveUniqueMcpServerName(server, existingNames);
    existingNames.add(uniqueName);
    injectedServerNames.push(uniqueName);

    const serverConfig: AgyMcpServerConfig = {
      url: server.url,
      ...(server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {}),
    };
    existingServers[uniqueName] = serverConfig;
  }

  const updatedConfig: AgyMcpConfigFile = {
    ...parsedConfig,
    mcpServers: existingServers,
  };

  await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2) + "\n", { mode: 0o600 });

  const cleanup = async (): Promise<void> => {
    try {
      const currentRaw = await fs.readFile(configPath, "utf8");
      const currentJson = JSON.parse(currentRaw);
      if (!currentJson || typeof currentJson !== "object" || Array.isArray(currentJson)) {
        return;
      }

      const currentServers: Record<string, AgyMcpServerConfig> =
        currentJson.mcpServers && typeof currentJson.mcpServers === "object"
          ? { ...currentJson.mcpServers }
          : {};

      for (const injectedName of injectedServerNames) {
        delete currentServers[injectedName];
      }

      const remainingServerKeys = Object.keys(currentServers);

      if (remainingServerKeys.length === 0 && !fileExistedBefore) {
        // If the file was created solely for this run and now has no servers, clean it up
        await fs.rm(configPath, { force: true }).catch(() => undefined);
      } else {
        const cleanedConfig = {
          ...currentJson,
          mcpServers: currentServers,
        };
        await fs.writeFile(configPath, JSON.stringify(cleanedConfig, null, 2) + "\n", { mode: 0o600 });
      }
    } catch {
      // Ignore cleanup errors on missing or inaccessible files
    }
  };

  return {
    configPath,
    injectedServerNames,
    cleanup,
  };
}

export interface StageAgyMcpConfigInput {
  servers: AdapterRuntimeMcpServer[];
  runId?: string;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Stages Paperclip-managed MCP configuration into a private temporary directory
 * suitable for syncing into a sandbox execution target.
 */
export async function stageAgyMcpConfigForSync(
  input: StageAgyMcpConfigInput,
): Promise<string> {
  const prefix = input.runId
    ? `paperclip-agy-mcp-sync-${input.runId}-`
    : "paperclip-agy-mcp-sync-";
  const stagedDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(stagedDir, 0o700).catch(() => {});

  const hostConfigPath = resolveAgyMcpConfigPath(input.homedir, input.env);
  let parsedConfig: AgyMcpConfigFile = {};

  try {
    const raw = await fs.readFile(hostConfigPath, "utf8");
    if (raw.trim().length > 0) {
      const json = JSON.parse(raw);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsedConfig = json;
      }
    }
  } catch {
    // Missing or invalid config on host; start fresh
  }

  const existingServers: Record<string, AgyMcpServerConfig> =
    parsedConfig.mcpServers && typeof parsedConfig.mcpServers === "object" && !Array.isArray(parsedConfig.mcpServers)
      ? { ...parsedConfig.mcpServers }
      : {};

  const existingNames = new Set(Object.keys(existingServers));

  for (const server of input.servers) {
    const uniqueName = resolveUniqueMcpServerName(server, existingNames);
    existingNames.add(uniqueName);

    const serverConfig: AgyMcpServerConfig = {
      url: server.url,
      ...(server.token ? { headers: { Authorization: `Bearer ${server.token}` } } : {}),
    };
    existingServers[uniqueName] = serverConfig;
  }

  const updatedConfig: AgyMcpConfigFile = {
    ...parsedConfig,
    mcpServers: existingServers,
  };

  await fs.writeFile(
    path.join(stagedDir, "mcp_config.json"),
    JSON.stringify(updatedConfig, null, 2) + "\n",
    { mode: 0o600 },
  );

  return stagedDir;
}
