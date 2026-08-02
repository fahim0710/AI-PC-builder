import "dotenv/config";
import { chatJson, extractJson, chatModel } from "../ai/huggingface.js";

const schema = {
  type: "object", additionalProperties: false, required: ["status"],
  properties: { status: { type: "string", enum: ["ok"] } },
};

try {
  const started = Date.now();
  const output = await chatJson([
    { role: "system", content: "Return the required JSON only." },
    { role: "user", content: "Confirm availability." },
  ], "availability_check", schema);
  const parsed = extractJson<{ status: string }>(output);
  console.log(JSON.stringify({ connected: parsed.status === "ok", model: chatModel, responseCharacters: output.length, milliseconds: Date.now() - started }));
} catch (error) {
  const failure = error as { name?: string; message?: string; httpResponse?: { status?: number; body?: unknown } };
  console.error(JSON.stringify({ connected: false, model: chatModel, error: failure.message, status: failure.httpResponse?.status, details: failure.httpResponse?.body }));
  process.exitCode = 1;
}
