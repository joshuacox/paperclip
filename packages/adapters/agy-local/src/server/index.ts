import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listAgySkills as listSkills, syncAgySkills as syncSkills } from "./skills.js";
export { listAgyModels } from "./models.js";
export { parseAgyJsonl, isAgyUnknownSessionError } from "./parse.js";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    const obj = parseObject(raw);
    const conversationId = asString(obj.conversationId, "") || asString(obj.sessionId, "");
    if (!conversationId) return null;
    const cwd = asString(obj.cwd, "");
    return { conversationId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params) {
    if (!params) return null;
    const conversationId = asString(params.conversationId, "") || asString(params.sessionId, "");
    if (!conversationId) return null;
    const cwd = asString(params.cwd, "");
    return { conversationId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params) {
    if (!params) return null;
    return asString(params.conversationId, "") || asString(params.sessionId, "") || null;
  },
};
