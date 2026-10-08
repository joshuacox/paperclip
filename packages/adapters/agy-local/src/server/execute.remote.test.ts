import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  restoreWorkspaceSpy,
  bridgeStopSpy,
  capturedProcessRuns,
  runLogTailMock,
  settleRunDispositionMock,
} = vi.hoisted(() => {
  const restoreWorkspaceSpy = vi.fn(async () => {});
  const bridgeStopSpy = vi.fn(async () => {});
  const runLogTailMock = { create: vi.fn() };
  const settleRunDispositionMock = vi.fn();
  const capturedProcessRuns: Array<{
    runId: string;
    target: any;
    command: string;
    args: string[];
    options: any;
  }> = [];

  return {
    restoreWorkspaceSpy,
    bridgeStopSpy,
    capturedProcessRuns,
    runLogTailMock,
    settleRunDispositionMock,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async (cmd) => cmd),
    readAdapterExecutionTargetHomeDir: vi.fn(async () => "/home/agent"),
    runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
      env: {
        PAPERCLIP_API_URL: "http://127.0.0.1:4310",
        PAPERCLIP_API_KEY: "bridge-token",
        PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      },
      runLogTail: runLogTailMock,
      settleRunDisposition: settleRunDispositionMock,
      stop: bridgeStopSpy,
    })),
    prepareAdapterExecutionTargetRuntime: vi.fn(),
    runAdapterExecutionTargetProcess: vi.fn(async (runId, target, command, args, options) => {
      capturedProcessRuns.push({ runId, target, command, args, options });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout:
          JSON.stringify({ event: "init", conversation_id: "conv-remote-1" }) +
          "\n" +
          JSON.stringify({
            event: "result",
            result: { status: "SUCCESS", conversation_id: "conv-remote-1", response: "remote success" },
          }) +
          "\n",
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    prepareAdapterExecutionTargetRuntime,
    readAdapterExecutionTargetHomeDir,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
    runAdapterExecutionTargetShellCommand,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

function makeSandboxTarget(): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/remote/workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };
}

describe("agy-local execute (remote execution)", () => {
  const tmpDirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-remote-exec-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    capturedProcessRuns.length = 0;
    restoreWorkspaceSpy.mockClear();
    bridgeStopSpy.mockClear();
    prepareAdapterExecutionTargetRuntime.mockReset();

    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/runtime",
      assetDirs: {
        skills: "/remote/runtime/assets/skills",
        "agy-home": "/remote/runtime/assets/agy-home",
      },
      restoreWorkspace: async () => {
        await restoreWorkspaceSpy();
        const agyHomeAsset = input.assets?.find((a: any) => a.key === "agy-home");
        if (agyHomeAsset?.restore) {
          await agyHomeAsset.restore({
            assetDir: "/remote/runtime/assets/agy-home",
            readFile: async () =>
              Buffer.from(
                JSON.stringify({
                  access_token: "refreshed-sandbox-token",
                  expiry: new Date(Date.now() + 86400000).toISOString(),
                }),
              ),
          });
        }
      },
    }));
  });

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  it("stages workspace, skills, and agy-home runtime assets and mounts remote skills via --add-dir", async () => {
    const rootDir = await makeTmpDir();
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const hostHome = path.join(rootDir, "home");
    const hostAgyDir = path.join(hostHome, ".gemini", "antigravity-cli");
    await fs.mkdir(hostAgyDir, { recursive: true });
    await fs.writeFile(
      path.join(hostAgyDir, "antigravity-oauth-token"),
      JSON.stringify({
        access_token: "initial-token",
        expiry: new Date(Date.now() + 1000).toISOString(),
      }),
    );

    const ctx: AdapterExecutionContext = {
      runId: "run-remote-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Remote Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: {
          HOME: hostHome,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
        },
      },
      executionTarget: makeSandboxTarget(),
      onLog: async () => {},
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("conv-remote-1");

    // Runtime was prepared with skills and agy-home assets
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterKey: "agy",
        target: expect.objectContaining({ kind: "remote", transport: "sandbox" }),
        workspaceLocalDir: workspaceDir,
        assets: expect.arrayContaining([
          expect.objectContaining({ key: "skills" }),
          expect.objectContaining({ key: "agy-home" }),
        ]),
      }),
    );

    // Process was executed with remote cwd and --add-dir for remote skills
    expect(capturedProcessRuns).toHaveLength(1);
    const run = capturedProcessRuns[0];
    expect(run.options.cwd).toBe("/remote/workspace");
    expect(run.args).toContain("--add-dir");
    expect(run.args).toContain("/remote/runtime/assets/skills");
    expect(run.args).toContain("/remote/workspace");

    // Shell command materialized agy-home in sandbox
    expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledWith(
      "run-remote-1",
      expect.objectContaining({ kind: "remote" }),
      expect.stringContaining(".gemini/antigravity-cli"),
      expect.anything(),
    );

    // Workspace restoration ran on completion
    expect(restoreWorkspaceSpy).toHaveBeenCalled();
  });

  it("starts Paperclip bridge and injects bridge environment into the process", async () => {
    const rootDir = await makeTmpDir();
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const ctx: AdapterExecutionContext = {
      runId: "run-remote-bridge",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Remote Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
        },
      },
      executionTarget: makeSandboxTarget(),
      authToken: "secret-token",
      onLog: async () => {},
    };

    await execute(ctx);

    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterKey: "agy",
        runId: "run-remote-bridge",
      }),
    );

    expect(capturedProcessRuns).toHaveLength(1);
    const run = capturedProcessRuns[0];
    expect(run.options.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(run.options.env.PAPERCLIP_API_KEY).toBe("bridge-token");
    expect(run.options.env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(run.options.runLogTail).toBe(runLogTailMock);
    expect(run.options.settleRunDisposition).toBe(settleRunDispositionMock);
    expect(typeof run.options.onProcessStopped).toBe("function");

    // Bridge stop called in finally
    expect(bridgeStopSpy).toHaveBeenCalled();
  });

  it("restores remote workspace and merges refreshed sandbox token back to host", async () => {
    const rootDir = await makeTmpDir();
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const hostHome = path.join(rootDir, "home");
    const hostAgyDir = path.join(hostHome, ".gemini", "antigravity-cli");
    await fs.mkdir(hostAgyDir, { recursive: true });
    const hostTokenPath = path.join(hostAgyDir, "antigravity-oauth-token");
    await fs.writeFile(
      hostTokenPath,
      JSON.stringify({
        access_token: "old-host-token",
        expiry: new Date(Date.now() + 1000).toISOString(),
      }),
    );

    const ctx: AdapterExecutionContext = {
      runId: "run-remote-copyback",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Remote Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: {
          HOME: hostHome,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
        },
      },
      executionTarget: makeSandboxTarget(),
      onLog: async () => {},
    };

    await execute(ctx);

    expect(restoreWorkspaceSpy).toHaveBeenCalled();
    const hostTokenContent = JSON.parse(await fs.readFile(hostTokenPath, "utf8"));
    expect(hostTokenContent.access_token).toBe("refreshed-sandbox-token");
  });

  it("resumes session when remote execution identity matches, but resets session when identity differs", async () => {
    const rootDir = await makeTmpDir();
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    // Test matching remote session
    const matchingCtx: AdapterExecutionContext = {
      runId: "run-matching-session",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Remote Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "conv-matched-1",
        sessionParams: {
          sessionId: "conv-matched-1",
          cwd: "/remote/workspace",
          remoteExecution: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "daytona",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: "conv-matched-1",
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
        },
      },
      executionTarget: makeSandboxTarget(),
      onLog: async () => {},
    };

    await execute(matchingCtx);

    expect(capturedProcessRuns).toHaveLength(1);
    expect(capturedProcessRuns[0].args).toContain("--conversation");
    expect(capturedProcessRuns[0].args).toContain("conv-matched-1");

    capturedProcessRuns.length = 0;

    // Test mismatched remote session (e.g. different providerKey or remote cwd)
    const mismatchedCtx: AdapterExecutionContext = {
      runId: "run-mismatched-session",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Remote Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "conv-mismatched-1",
        sessionParams: {
          sessionId: "conv-mismatched-1",
          cwd: "/different/remote/workspace",
          remoteExecution: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "docker",
            remoteCwd: "/different/remote/workspace",
          },
        },
        sessionDisplayId: "conv-mismatched-1",
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
        },
      },
      executionTarget: makeSandboxTarget(),
      onLog: async () => {},
    };

    await execute(mismatchedCtx);

    expect(capturedProcessRuns).toHaveLength(1);
    expect(capturedProcessRuns[0].args).not.toContain("conv-mismatched-1");
  });
});
