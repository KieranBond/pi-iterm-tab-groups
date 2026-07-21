import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SemanticConfig } from "./config";
import {
  classificationPrompt,
  parseDecisions,
  parseSummary,
  protectSummary,
  summaryPrompt,
  type SemanticModel,
} from "./semantic-model";

export function createPiSemanticModel(ctx: ExtensionContext, config: SemanticConfig): SemanticModel {
  const invoke = async (prompt: string, maxTokens: number, signal?: AbortSignal): Promise<string> => {
    const model = ctx.modelRegistry.find(config.provider, config.model);
    if (!model) throw new Error(`Semantic model is not available: ${config.provider}/${config.model}`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${config.provider}` : auth.error);
    const message: UserMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };
    const response = await complete(
      model,
      { messages: [message] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens, signal },
    );
    if (response.stopReason !== "stop") throw new Error(`Semantic model stopped with ${response.stopReason}`);
    return response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  };

  return {
    summarize: async (prompts, signal) => {
      const response = await invoke(summaryPrompt(prompts), 300, signal);
      try {
        return protectSummary(parseSummary(response), prompts);
      } catch {
        throw new Error("Semantic summary response was invalid");
      }
    },
    classify: async (input, signal) => {
      const response = await invoke(classificationPrompt(input), 900, signal);
      try {
        return parseDecisions(response);
      } catch {
        throw new Error("Semantic classification response was invalid");
      }
    },
  };
}
