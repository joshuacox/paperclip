import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseAgyStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const eventType = asString(parsed.event);

  if (eventType === "init") {
    const conversationId = asString(parsed.conversation_id);
    return [
      {
        kind: "init",
        ts,
        model: "agy",
        sessionId: conversationId,
      },
    ];
  }

  if (eventType === "step_update") {
    const stepUpdate = asRecord(parsed.step_update);
    if (!stepUpdate) return [];

    const stepType = asString(stepUpdate.step_type);

    if (stepType === "agent_response") {
      const textDelta = asString(stepUpdate.text_delta);
      if (textDelta) {
        return [{ kind: "assistant", ts, text: textDelta }];
      }
      return [];
    }

    if (stepType === "tool") {
      const toolName = asString(stepUpdate.tool_name, "tool");
      const toolInfo = asRecord(stepUpdate.tool_info) ?? {};
      const params = asRecord(toolInfo.parameters) ?? {};
      const state = asString(stepUpdate.state);

      const callEntry: TranscriptEntry = {
        kind: "tool_call",
        ts,
        name: toolName,
        toolUseId: toolName,
        input: params,
      };

      if (state === "ACTIVE") {
        return [callEntry];
      }

      if (state === "DONE") {
        const output = asString(toolInfo.output, "done");
        return [
          callEntry,
          {
            kind: "tool_result",
            ts,
            toolUseId: toolName,
            content: output,
            isError: false,
          },
        ];
      }

      if (state === "ERROR") {
        const errObj = asRecord(toolInfo.error);
        const errMsg = asString(errObj?.message) || asString(toolInfo.error) || "Tool execution failed";
        return [
          callEntry,
          {
            kind: "tool_result",
            ts,
            toolUseId: toolName,
            content: errMsg,
            isError: true,
          },
        ];
      }

      return [callEntry];
    }

    if (stepType === "user_input") {
      return [{ kind: "user", ts, text: "Turn started" }];
    }

    if (stepType === "system_message") {
      return [{ kind: "system", ts, text: "System update" }];
    }
  }

  if (eventType === "result") {
    const resultObj = asRecord(parsed.result);
    if (!resultObj) return [];
    const response = asString(resultObj.response);
    const isError = asString(resultObj.status) === "ERROR";
    const usage = asRecord(resultObj.usage);
    return [
      {
        kind: "result",
        ts,
        text: response,
        inputTokens: asNumber(usage?.input_tokens, 0),
        outputTokens: asNumber(usage?.output_tokens, 0),
        cachedTokens: asNumber(usage?.cache_read_tokens, 0),
        costUsd: 0,
        subtype: isError ? "error" : "success",
        isError,
        errors: isError && response ? [response] : [],
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}
