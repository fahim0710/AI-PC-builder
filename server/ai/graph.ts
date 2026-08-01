import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import { chatJson, extractJson } from "./huggingface.js";
import { retrieveManual, retrieveProducts, searchCatalog, searchWeb, type ProductCandidate } from "./retrieval.js";

const Intent = z.object({ requestType: z.enum(["build", "product_question", "general"]), goal: z.string(), budget: z.number().int().positive().nullable(), resolution: z.string().nullable(), targetFps: z.number().int().positive().nullable(), searchQuery: z.string() });
const ModelBuild = z.object({ answer: z.string(), productIds: z.array(z.string()), assumptions: z.array(z.string()).default([]) });
const intentJsonSchema = { type: "object", additionalProperties: false, required: ["requestType", "goal", "budget", "resolution", "targetFps", "searchQuery"], properties: { requestType: { type: "string", enum: ["build", "product_question", "general"] }, goal: { type: "string" }, budget: { type: ["integer", "null"] }, resolution: { type: ["string", "null"] }, targetFps: { type: ["integer", "null"] }, searchQuery: { type: "string" } } };
const buildJsonSchema = { type: "object", additionalProperties: false, required: ["answer", "productIds", "assumptions"], properties: { answer: { type: "string" }, productIds: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } } } };
type IntentValue = z.infer<typeof Intent>;

const AiState = Annotation.Root({
  question: Annotation<string>(),
  history: Annotation<Array<{ role: "user" | "assistant"; content: string }>>(),
  intent: Annotation<IntentValue | null>(),
  manual: Annotation<Array<{ content: string; source: string; score: number }>>(),
  web: Annotation<Array<{ title: string; url: string; snippet: string }>>(),
  products: Annotation<ProductCandidate[]>(),
  draft: Annotation<z.infer<typeof ModelBuild> | null>(),
  response: Annotation<AiResult | null>(),
});

export type AiBuildItem = ProductCandidate & { reason: string };
export type AiResult = {
  answer: string; build: AiBuildItem[]; total: number; budget: number | null;
  sources: Array<{ title: string; url?: string }>; guardrails: { passed: boolean; checks: string[]; warnings: string[] };
};

const parseBudget = (question: string) => {
  const normalized = question.replace(/,/g, "");
  const lakh = normalized.match(/(?:৳|tk\.?|bdt)?\s*(\d+(?:\.\d+)?)\s*(?:lakh|lac)/i);
  if (lakh) return Math.round(Number(lakh[1]) * 100_000);
  const thousand = normalized.match(/(?:৳|tk\.?|bdt)?\s*(\d+(?:\.\d+)?)\s*k\b/i);
  if (thousand) return Math.round(Number(thousand[1]) * 1_000);
  const prefixed = normalized.match(/(?:budget|under|within|৳|tk\.?|bdt)\s*(?:is|of|:)?\s*(\d{4,8})/i);
  if (prefixed) return Number(prefixed[1]);
  const suffixed = normalized.match(/\b(\d{4,8})\s*(?:tk\.?|taka|bdt)\b/i);
  if (suffixed) return Number(suffixed[1]);
  const standalone = normalized.trim().match(/^(\d{4,8})$/);
  return standalone ? Number(standalone[1]) : null;
};

const classify = (context: string): IntentValue["requestType"] => {
  if (/\b(change|replace|swap|switch|instead|same budget|modify|revise)\b/i.test(context)) return "build";
  if (/\b(build|suggest|recommend|gaming pc|editing pc|workstation)\b/i.test(context)) return "build";
  if (/\b(price|cost|how much|find|show|processor|cpu|gpu|graphics card|ram|ssd|motherboard|power supply)\b/i.test(context)) return "product_question";
  return "general";
};

async function analyze(state: typeof AiState.State) {
  const previousGoal = [...state.history].reverse().find((message) => message.role === "user" && /\b(build|suggest|recommend|price|cost|processor|cpu|gpu|ram|ssd)\b/i.test(message.content))?.content;
  const isFollowUp = /^\s*(?:\d[\d,.]*\s*(?:tk|taka|bdt)?|yes|no)\s*$/i.test(state.question) || /\b(change|replace|swap|switch|instead|same budget|modify|revise|make it|what about)\b/i.test(state.question);
  const context = previousGoal && isFollowUp ? `${previousGoal}. Follow-up request: ${state.question}` : state.question;
  const fallback: IntentValue = { requestType: classify(context), goal: context, budget: parseBudget(state.question) ?? parseBudget(context), resolution: null, targetFps: null, searchQuery: `${context} system requirements recommended specifications` };
  if (fallback.requestType !== "general") return { intent: fallback };
  try {
    const output = await chatJson([{ role: "system", content: "Classify the request and extract PC intent. Budget must be integer BDT or null." }, { role: "user", content: context }], "pc_intent", intentJsonSchema);
    const parsed = Intent.parse(extractJson(output));
    return { intent: { ...parsed, budget: parsed.budget ?? fallback.budget } };
  } catch { return { intent: fallback }; }
}

const manualRetriever = RunnableLambda.from((query: string) => retrieveManual(query));
const webResearcher = RunnableLambda.from((query: string) => searchWeb(query));
const productRetriever = RunnableLambda.from((budget: number) => retrieveProducts(budget));
const catalogSearcher = RunnableLambda.from((query: string) => searchCatalog(query));

async function manualNode(state: typeof AiState.State) { return { manual: await manualRetriever.invoke(state.question) }; }
async function webNode(state: typeof AiState.State) { return { web: await webResearcher.invoke(state.intent!.searchQuery) }; }
async function productsNode(state: typeof AiState.State) {
  if (state.intent?.requestType === "product_question") return { products: await catalogSearcher.invoke(state.intent.goal) };
  return { products: state.intent?.budget ? await productRetriever.invoke(state.intent.budget) : [] };
}

async function generate(state: typeof AiState.State) {
  if (state.intent?.requestType === "build" && !state.intent.budget) return { draft: { answer: "What is your maximum budget in BDT? I need it before selecting real products from the catalog.", productIds: [], assumptions: [] } };
  if (state.intent?.requestType === "product_question") {
    if (!state.products.length) return { draft: { answer: "I could not find matching active products in the catalog. Try a brand/model name or fewer filters.", productIds: [], assumptions: [] } };
    try {
      const output = await chatJson([{ role: "system", content: "Answer the catalog question using only DATABASE PRODUCTS. Never alter names, IDs or prices. Choose up to 8 relevant IDs." }, { role: "user", content: `QUESTION: ${state.question}\nDATABASE PRODUCTS: ${JSON.stringify(state.products)}` }], "catalog_answer", buildJsonSchema);
      return { draft: ModelBuild.parse(extractJson(output)) };
    } catch { return { draft: { answer: "Here are the matching live catalog products.", productIds: state.products.slice(0, 8).map((product) => product.id), assumptions: [] } }; }
  }
  if (!state.intent?.budget) return { draft: { answer: "Tell me whether you want a full build, a product search, or compatibility guidance.", productIds: [], assumptions: [] } };
  const context = {
    intent: state.intent,
    manual: state.manual.map((item) => item.content),
    web: state.web,
    products: state.products.map(({ id, name, category, price, specifications }) => ({ id, name, category, price, specifications: JSON.stringify(specifications).slice(0, 450) })),
  };
  const history = state.history.slice(-8);
  try {
    const output = await chatJson([
      { role: "system", content: `You are NexRig's PC build planner. Products and prices in DATABASE CANDIDATES are the only allowed catalog facts. Never invent an ID, product, price, benchmark, compatibility claim, or web source. Select at most one product per category and remain within budget. For revision requests, preserve the previous goal and budget while changing what the user requested. Prefer CPU, Motherboard, Ram, Graphics Card, SSD, Power Supply and Casing. The UI renders validated product cards, so do not repeat the full product list, IDs, or prices in answer. The answer must be concise Markdown with headings: "## Recommendation", "## Why this works", and "## Trade-offs". Explain the requested change and clearly label uncertainty.` },
      ...history,
      { role: "user", content: `QUESTION: ${state.question}\nCONTEXT: ${JSON.stringify(context)}` },
    ], "pc_build_recommendation", buildJsonSchema);
    return { draft: ModelBuild.parse(extractJson(output)) };
  } catch (error) {
    console.error("Hugging Face build generation failed", error);
    return { draft: { answer: "The model response was unavailable, so I applied the deterministic database fallback.", productIds: [], assumptions: ["Model generation fallback used"] } };
  }
}

function validate(state: typeof AiState.State) {
  const budget = state.intent?.budget ?? null;
  if (state.intent?.requestType === "product_question") {
    const allowed = new Map(state.products.map((product) => [product.id, product]));
    let selected = [...new Set(state.draft?.productIds ?? [])].map((id) => allowed.get(id)).filter(Boolean) as ProductCandidate[];
    if (!selected.length) selected = state.products.slice(0, 8);
    return { response: { answer: state.draft?.answer ?? "Here are matching database products.", build: selected.map((product) => ({ ...product, reason: "Matched from the active PostgreSQL catalog." })), total: 0, budget: null, sources: [], guardrails: { passed: true, checks: ["All displayed products exist in PostgreSQL", "Prices copied from PostgreSQL"], warnings: [] } } };
  }
  if (!budget) return { response: { answer: state.draft!.answer, build: [], total: 0, budget, sources: [], guardrails: { passed: true, checks: ["Budget clarification requested"], warnings: [] } } };
  const allowed = new Map(state.products.map((product) => [product.id, product]));
  const requested = [...new Set(state.draft?.productIds ?? [])].map((id) => allowed.get(id)).filter(Boolean) as ProductCandidate[];
  const required = ["cpu", "motherboard", "ram", "graphics card", "ssd", "power supply", "casing"];
  let selected = requested.filter((product, index, all) => all.findIndex((item) => item.category.toLowerCase() === product.category.toLowerCase()) === index);
  const requestedValid = selected.length === requested.length && required.every((category) => selected.some((product) => product.category.toLowerCase() === category));
  if (!requestedValid || selected.reduce((sum, product) => sum + product.price, 0) > budget) {
    selected = required.map((category) => state.products.filter((product) => product.category.toLowerCase() === category).sort((a, b) => a.price - b.price)[0]).filter(Boolean);
  }
  const cpu = selected.find((product) => product.category.toLowerCase() === "cpu");
  let motherboard = selected.find((product) => product.category.toLowerCase() === "motherboard");
  let ram = selected.find((product) => product.category.toLowerCase() === "ram");
  const cpuVendor = cpu && /\b(amd|ryzen)\b/i.test(cpu.name) ? "amd" : cpu && /\bintel\b/i.test(cpu.name) ? "intel" : null;
  const boardVendor = (name: string) => /\b(amd|am4|am5|a320|a520|a620|b450|b550|b650|x570|x670)\b/i.test(name) ? "amd" : /\b(intel|h510|h610|h710|b560|b660|b760|z590|z690|z790)\b/i.test(name) ? "intel" : null;
  if (cpuVendor && motherboard && boardVendor(motherboard.name) && boardVendor(motherboard.name) !== cpuVendor) {
    const replacement = state.products.filter((product) => product.category.toLowerCase() === "motherboard" && boardVendor(product.name) === cpuVendor).sort((a, b) => a.price - b.price)[0];
    if (replacement) { selected = selected.map((product) => product.id === motherboard!.id ? replacement : product); motherboard = replacement; }
  }
  const memoryGeneration = motherboard?.name.match(/DDR[45]/i)?.[0].toUpperCase();
  if (memoryGeneration && ram && !ram.name.toUpperCase().includes(memoryGeneration)) {
    const replacement = state.products.filter((product) => product.category.toLowerCase() === "ram" && product.name.toUpperCase().includes(memoryGeneration)).sort((a, b) => a.price - b.price)[0];
    if (replacement) { selected = selected.map((product) => product.id === ram!.id ? replacement : product); ram = replacement; }
  }
  const editingWorkload = /\b(video[ -]?edit|editing|premiere|after effects|davinci|resolve)\b/i.test(state.intent?.goal ?? "");
  const ramCapacity = (name: string) => Number(name.match(/\b(8|16|32|48|64|96|128)\s*GB\b/i)?.[1] ?? 0);
  if (editingWorkload && ram && ramCapacity(ram.name) < 32) {
    const replacement = state.products
      .filter((product) => product.category.toLowerCase() === "ram" && (!memoryGeneration || product.name.toUpperCase().includes(memoryGeneration)) && ramCapacity(product.name) >= 32)
      .sort((a, b) => a.price - b.price)[0];
    if (replacement) { selected = selected.map((product) => product.id === ram!.id ? replacement : product); ram = replacement; }
  }
  let total = selected.reduce((sum, product) => sum + product.price, 0);
  if (total > budget) {
    for (const category of ["graphics card", "casing", "ssd", "power supply"]) {
      const current = selected.find((product) => product.category.toLowerCase() === category);
      if (!current) continue;
      const replacement = state.products.filter((product) => product.category.toLowerCase() === category && product.price < current.price).sort((a, b) => a.price - b.price)[0];
      if (replacement) {
        selected = selected.map((product) => product.id === current.id ? replacement : product);
        total = selected.reduce((sum, product) => sum + product.price, 0);
      }
      if (total <= budget) break;
    }
  }
  const complete = required.every((category) => selected.some((product) => product.category.toLowerCase() === category));
  const passed = complete && total <= budget && selected.every((product) => allowed.has(product.id));
  const build = selected.map((product) => ({ ...product, reason: `Selected from the live ${product.category} catalog for this budget.` }));
  const warnings = [
    ...(state.manual.length ? [] : ["No PC-build manual has been ingested yet; manual-based compatibility retrieval was unavailable."]),
    ...(state.web.length ? [] : ["Live web context was unavailable; verify the game's current official requirements."]),
    ...(!memoryGeneration ? ["The motherboard memory generation could not be determined from catalog text."] : []),
    ...(editingWorkload && (!ram || ramCapacity(ram.name) < 32) ? ["No suitable 32 GB memory product was available inside the retrieved budget range; 32 GB is recommended for video editing."] : []),
    "Exact CPU socket/BIOS support, physical clearance and PSU connectors still require structured specification verification before purchase.",
  ];
  const answer = passed ? `${state.draft?.answer ?? "Here is a database-backed build."}\n\nValidated catalog total: ৳${total.toLocaleString("en-BD")}.` : `I could not create a complete database-backed build within ৳${budget.toLocaleString("en-BD")}. Try increasing the budget or tell me which parts you already own.`;
  return { response: {
    answer, build: passed ? build : [], total: passed ? total : 0, budget,
    sources: [...state.manual.map((item) => ({ title: item.source })), ...state.web.map((item) => ({ title: item.title, url: item.url }))],
    guardrails: { passed, checks: ["All product IDs exist in PostgreSQL", "Prices copied from PostgreSQL", "No duplicate categories", "CPU and motherboard platform checked", "Motherboard and RAM generation checked", ...(editingWorkload ? ["Video-editing memory target checked"] : []), "Total checked against budget", "Required categories checked"], warnings },
  } };
}

export const pcBuilderGraph = new StateGraph(AiState)
  .addNode("analyze", analyze).addNode("retrieve_manual", manualNode).addNode("research_web", webNode)
  .addNode("retrieve_products", productsNode).addNode("generate", generate).addNode("validate", validate)
  .addEdge(START, "analyze").addEdge("analyze", "retrieve_manual").addEdge("analyze", "research_web").addEdge("analyze", "retrieve_products")
  .addEdge(["retrieve_manual", "research_web", "retrieve_products"], "generate").addEdge("generate", "validate").addEdge("validate", END)
  .compile();

export async function runPcBuilder(question: string, history: Array<{ role: "user" | "assistant"; content: string }>) {
  const result = await pcBuilderGraph.invoke({ question, history, intent: null, manual: [], web: [], products: [], draft: null, response: null });
  if (!result.response) throw new Error("AI workflow produced no response");
  return result.response;
}
