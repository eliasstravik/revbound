import { defineAgent } from "eve";
import { chatModel } from "../model.js";

export type ChatAgentOptions = { model?: string };

/** The agent's config: its model (model.ts) and nothing else; eve's defaults cover the rest. */
export function chatAgent(options: ChatAgentOptions = {}): ReturnType<typeof defineAgent> {
  return defineAgent(chatModel(options.model) as Parameters<typeof defineAgent>[0]);
}
