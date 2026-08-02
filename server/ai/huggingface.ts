import { InferenceClient } from "@huggingface/inference";

let client: InferenceClient | undefined;
function getClient() {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN is required for the AI service");
  return client ??= new InferenceClient(token);
}
export const chatModel = process.env.HF_CHAT_MODEL ?? "openai/gpt-oss-120b:fastest";
export const embeddingModel = process.env.HF_EMBEDDING_MODEL ?? "sentence-transformers/all-MiniLM-L6-v2";
export const structuredJsonSupported = !/llama-3\.1-8b-instruct/i.test(chatModel);

export async function chat(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await getClient().chatCompletion({ model: chatModel, provider: "auto", messages, max_tokens: 350, temperature: 0.2 });
      const content = result.choices[0]?.message?.content?.trim();
      if (content) return content;
      lastError = new Error("Hugging Face returned an empty message");
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function chatJson(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, name: string, schema: Record<string, unknown>) {
  let lastError: unknown;
  const strictSchemaSupported = structuredJsonSupported;
  const efficientMessages = strictSchemaSupported ? messages : [
    { role: "system" as const, content: `Return one JSON object only. It must match this schema: ${JSON.stringify(schema)}` },
    ...messages,
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await getClient().chatCompletion({
        model: chatModel, provider: "auto", messages: efficientMessages, max_tokens: 650, temperature: 0.1, reasoning_effort: "low",
        response_format: strictSchemaSupported ? { type: "json_schema", json_schema: { name, strict: true, schema } } : { type: "json_object" },
      });
      const content = result.choices[0]?.message?.content?.trim();
      if (content) return content;
      lastError = new Error("Hugging Face returned an empty structured message");
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function embed(text: string): Promise<number[]> {
  const output = await getClient().featureExtraction({ model: embeddingModel, provider: "hf-inference", inputs: text });
  if (!Array.isArray(output)) throw new Error("Hugging Face returned an invalid embedding");
  if (typeof output[0] === "number") return output as number[];
  const rows = output as number[][];
  if (!rows.length) return [];
  return rows[0].map((_, index) => rows.reduce((sum, row) => sum + (row[index] ?? 0), 0) / rows.length);
}

export function extractJson<T>(value: string): T {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  return JSON.parse(candidate) as T;
}
