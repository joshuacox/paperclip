import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "agy_local";
export const label = "Antigravity (agy)";

export const DEFAULT_AGY_LOCAL_MODEL = "gemini-3.7-flash-high";

export const models = [
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" },
  { id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium)" },
  { id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Gemini 3.5 Flash Low as the lower-cost Antigravity lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "gemini-3.5-flash-low",
      effort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# agy_local agent configuration

Adapter: agy_local

Use when:
- You want Paperclip to run the Antigravity (agy) CLI locally on the host machine
- You want conversation sessions resumed across heartbeats with --conversation <id>
- You want Paperclip skills and workspace directories injected via --add-dir

Don't use when:
- You need webhook-style external HTTP invocation (use http or openclaw_gateway)
- You only need a one-shot process without agentic tool execution (use process adapter)
- Antigravity CLI (agy) is not installed on the machine running Paperclip

Core fields:
- cwd (string, optional): absolute working directory fallback for the agent process (defaults to workspace directory)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file (e.g. AGENTS.md) prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): model ID. Defaults to "gemini-3.7-flash-high"
- effort (string, optional): reasoning effort (low | medium | high)
- mode (string, optional): execution mode (accept-edits | plan)
- dangerouslySkipPermissions (boolean, optional, default false): allow non-interactive tool calls without prompting
- command (string, optional): executable command name or path (defaults to "agy")
- extraArgs (string[], optional): additional CLI args passed to agy
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs execute via non-interactive print mode: \`agy --print <prompt> --output-format stream-json --input-format text\`.
- Sessions are maintained using \`--conversation <id>\` and automatically retried if a session is missing.
- Workspace directory is added to Antigravity's context via \`--add-dir <cwd>\`.
`;
