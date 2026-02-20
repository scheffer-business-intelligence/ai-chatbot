export const AGENT_ENGINE_CHAT_MODEL = "google/scheffer-agent-engine";
export const DEFAULT_CHAT_MODEL = AGENT_ENGINE_CHAT_MODEL;

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  // Scheffer
  {
    id: AGENT_ENGINE_CHAT_MODEL,
    name: "Scheffer Agente Engine",
    provider: "google",
    description: "Google ADK agent deployed on Vertex AI Agent Engine",
  },

  // Google
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    provider: "google",
    description: "Direct Gemini API model",
  },

  // OpenAI
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    provider: "openai",
    description: "Direct OpenAI API model",
  },
];

// Group models by provider for UI
export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
