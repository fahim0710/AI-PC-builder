import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import { chat, chatJson, extractJson, structuredJsonSupported } from "./huggingface.js";
import { retrieveManual, retrieveProducts, searchCatalog, searchWeb, type ProductCandidate } from "./retrieval.js";

const Intent = z.object({ requestType: z.enum(["build", "product_question", "general"]), goal: z.string(), budget: z.number().int().positive().nullable(), resolution: z.string().nullable(), targetFps: z.number().int().positive().nullable(), searchQuery: z.string() });
const ModelBuild = z.object({ answer: z.string(), productIds: z.array(z.string()), assumptions: z.array(z.string()).default([]) });
const intentJsonSchema = { type: "object", additionalProperties: false, required: ["requestType", "goal", "budget", "resolution", "targetFps", "searchQuery"], properties: { requestType: { type: "string", enum: ["build", "product_question", "general"] }, goal: { type: "string" }, budget: { type: ["integer", "null"] }, resolution: { type: ["string", "null"] }, targetFps: { type: ["integer", "null"] }, searchQuery: { type: "string" } } };
const buildJsonSchema = { type: "object", additionalProperties: false, required: ["answer", "productIds", "assumptions"], properties: { answer: { type: "string" }, productIds: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } } } };
type IntentValue = z.infer<typeof Intent>;

const parseModelBuild = (output: string) => {
  const raw = extractJson<Record<string, unknown>>(output);
  const productSource = raw.productIds ?? raw.product_ids ?? raw.selectedProductIds ?? raw.selected_product_ids ?? raw.products ?? raw.selected_products ?? [];
  const productIds = Array.isArray(productSource) ? productSource.map((item) => typeof item === "string" || typeof item === "number" ? String(item) : item && typeof item === "object" && "id" in item ? String(item.id) : "").filter(Boolean) : [];
  const assumptionSource = raw.assumptions ?? raw.notes ?? [];
  return ModelBuild.parse({
    answer: raw.answer ?? raw.response ?? raw.recommendation ?? raw.summary ?? "Here is our suggestion.",
    productIds,
    assumptions: Array.isArray(assumptionSource) ? assumptionSource.map(String) : [],
  });
};

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
  const explicitLongBudget = normalized.match(/(?:budget|under|within)\s*(?:is|of|:)?\s*(\d{4,8})|\b(\d{4,8})\s*(?:tk\.?|taka|bdt)\b/i);
  if (explicitLongBudget) return Number(explicitLongBudget[1] ?? explicitLongBudget[2]);
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
      const messages = [{ role: "system" as const, content: "Answer the catalog question concisely using only DATABASE PRODUCTS. Never invent or alter product facts." }, { role: "user" as const, content: `QUESTION: ${state.question}\nDATABASE PRODUCTS: ${JSON.stringify(state.products.slice(0, 8).map(({ id, name, category, price }) => ({ id, name, category, price })))}` }];
      if (!structuredJsonSupported) return { draft: { answer: await chat(messages), productIds: state.products.slice(0, 8).map((product) => product.id), assumptions: [] } };
      const output = await chatJson(messages, "catalog_answer", buildJsonSchema);
      return { draft: parseModelBuild(output) };
    } catch { return { draft: { answer: "Server busy now! Try again later.", productIds: [], assumptions: ["AI_UNAVAILABLE"] } }; }
  }
  if (!state.intent?.budget) return { draft: { answer: "Tell me whether you want a full build, a product search, or compatibility guidance.", productIds: [], assumptions: [] } };
  const context = {
    intent: state.intent,
    manual: state.manual.map((item) => item.content.slice(0, 800)),
    web: state.web.map((item) => ({ title: item.title, url: item.url, snippet: item.snippet.slice(0, 500) })),
    products: structuredJsonSupported ? state.products.filter((product) => (product.rank ?? 999) <= 3 || (product.cheapRank ?? 999) <= 1).map(({ id, name, category, price, specifications }) => ({ id, name, category, price, specifications: JSON.stringify(specifications).slice(0, 180) })) : [],
  };
  const history = state.history.slice(-6).map((message) => ({ ...message, content: message.content.slice(0, 900) }));
  try {
    const messages = [
      { role: "system", content: `You are NexRig's PC build planner. Products and prices in DATABASE CANDIDATES are the only allowed catalog facts. Never invent an ID, product, price, benchmark, compatibility claim, or web source. Select at most one product per category and remain within budget. For revision requests, preserve the previous goal and budget while changing what the user requested. Prefer CPU, Motherboard, Ram, Graphics Card, SSD, Power Supply and Casing. The UI renders validated product cards, so do not repeat the full product list, IDs, or prices in answer. The answer must be concise Markdown with headings: "## Recommendation", "## Why this works", and "## Trade-offs". Explain the requested change and clearly label uncertainty.` },
      ...history,
      { role: "user", content: `QUESTION: ${state.question}\nCONTEXT: ${JSON.stringify(context)}` },
    ] as Array<{ role: "system" | "user" | "assistant"; content: string }>;
    if (!structuredJsonSupported) return { draft: { answer: await chat(messages), productIds: [], assumptions: [] } };
    const output = await chatJson(messages, "pc_build_recommendation", buildJsonSchema);
    return { draft: parseModelBuild(output) };
  } catch (error) {
    console.error("Hugging Face build generation failed", error);
    return { draft: { answer: "Server busy now! Try again later.", productIds: [], assumptions: ["AI_UNAVAILABLE"] } };
  }
}

function validate(state: typeof AiState.State) {
  const budget = state.intent?.budget ?? null;
  if (state.draft?.assumptions.includes("AI_UNAVAILABLE")) return { response: { answer: "Server busy now! Try again later.", build: [], total: 0, budget, sources: [], guardrails: { passed: false, checks: ["AI availability checked"], warnings: [] } } };
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
    selected = required.map((category) => state.products.filter((product) => product.category.toLowerCase() === category).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.price - b.price)[0]).filter(Boolean);
  }
  const cpu = selected.find((product) => product.category.toLowerCase() === "cpu");
  let motherboard = selected.find((product) => product.category.toLowerCase() === "motherboard");
  let ram = selected.find((product) => product.category.toLowerCase() === "ram");
  const cpuVendor = cpu && /\b(amd|ryzen)\b/i.test(cpu.name) ? "amd" : cpu && /\bintel\b/i.test(cpu.name) ? "intel" : null;
  const boardVendor = (name: string) => /\b(amd|am4|am5|a320|a520|a620|b350|b450|b550|b650|b840|x370|x470|x570|x670|x870)\b/i.test(name) ? "amd" : /\b(intel|h61|h81|h110|h170|h270|h310|h410|h470|h510|h570|h610|h670|h710|h770|b150|b250|b360|b460|b560|b660|b760|z170|z270|z370|z390|z490|z590|z690|z790|lga1151|lga1200|lga1700)\b/i.test(name) ? "intel" : null;
  if (cpuVendor && motherboard && boardVendor(motherboard.name) !== cpuVendor) {
    const replacement = state.products.filter((product) => product.category.toLowerCase() === "motherboard" && boardVendor(product.name) === cpuVendor).sort((a, b) => a.price - b.price)[0];
    if (replacement) { selected = selected.map((product) => product.id === motherboard!.id ? replacement : product); motherboard = replacement; }
  }
  const amdCpuSocket = (name: string) => {
    const series = Number(name.match(/\bRyzen\s+\d\s+(\d)\d{3}[A-Z]*\b/i)?.[1] ?? 0);
    return series >= 7 ? "am5" : series ? "am4" : null;
  };
  const amdBoardSocket = (name: string) => /\b(am5|a620|b650|b840|x670|x870)\b/i.test(name) ? "am5" : /\b(am4|a320|a520|b350|b450|b550|x370|x470|x570)\b/i.test(name) ? "am4" : null;
  if (cpuVendor === "amd" && cpu && motherboard) {
    const socket = amdCpuSocket(cpu.name);
    if (socket && amdBoardSocket(motherboard.name) !== socket) {
      const replacement = state.products.filter((product) => product.category.toLowerCase() === "motherboard" && amdBoardSocket(product.name) === socket).sort((a, b) => a.price - b.price)[0];
      if (replacement) { selected = selected.map((product) => product.id === motherboard!.id ? replacement : product); motherboard = replacement; }
    }
  }
  const intelCpuSocket = (name: string) => {
    const generation = Number(name.match(/\b(6|7|8|9|10|11|12|13|14)(?:th|st|nd|rd)\s*Gen\b/i)?.[1] ?? name.match(/\bCore\s+i[3579][ -]?(\d{2})\d{3}\b/i)?.[1] ?? 0);
    return generation >= 12 ? "lga1700" : generation >= 10 ? "lga1200" : generation >= 6 ? "legacy" : null;
  };
  const intelBoardSocket = (name: string) => /\b(lga1700|h610|h670|h710|h770|b660|b760|z690|z790)\b/i.test(name) ? "lga1700" : /\b(lga1200|h410|h470|h510|h570|b460|b560|z490|z590)\b/i.test(name) ? "lga1200" : /\b(lga1151|h61|h81|h110|h170|h270|h310|b150|b250|b360|z170|z270|z370|z390)\b/i.test(name) ? "legacy" : null;
  if (cpuVendor === "intel" && cpu && motherboard) {
    const socket = intelCpuSocket(cpu.name);
    if (socket && intelBoardSocket(motherboard.name) !== socket) {
      const replacement = state.products.filter((product) => product.category.toLowerCase() === "motherboard" && intelBoardSocket(product.name) === socket).sort((a, b) => a.price - b.price)[0];
      if (replacement) { selected = selected.map((product) => product.id === motherboard!.id ? replacement : product); motherboard = replacement; }
    }
  }
  const memoryGeneration = motherboard?.name.match(/DDR[45]/i)?.[0].toUpperCase();
  if (memoryGeneration && ram && !ram.name.toUpperCase().includes(memoryGeneration)) {
    const replacement = state.products.filter((product) => product.category.toLowerCase() === "ram" && product.name.toUpperCase().includes(memoryGeneration)).sort((a, b) => a.price - b.price)[0];
    if (replacement) { selected = selected.map((product) => product.id === ram!.id ? replacement : product); ram = replacement; }
  }
  const editingWorkload = /\b(video[ -]?edit(?:ing|or)?|premiere|after effects|davinci|resolve)\b/i.test(state.intent?.goal ?? "");
  const gamingWorkload = /\b(gaming|games?|gta|1080p|1440p|2160p|fps)\b/i.test(state.intent?.goal ?? "");
  const performanceWorkload = editingWorkload || gamingWorkload;
  const ramCapacity = (name: string) => Number(name.match(/\b(8|16|32|48|64|96|128)\s*GB\b/i)?.[1] ?? 0);
  const targetRam = editingWorkload ? 32 : gamingWorkload ? 16 : 0;
  if (targetRam && ram && ramCapacity(ram.name) < targetRam) {
    const replacement = state.products
      .filter((product) => product.category.toLowerCase() === "ram" && (!memoryGeneration || product.name.toUpperCase().includes(memoryGeneration)) && ramCapacity(product.name) >= targetRam)
      .sort((a, b) => a.price - b.price)[0];
    if (replacement) { selected = selected.map((product) => product.id === ram!.id ? replacement : product); ram = replacement; }
  }
  let gpu = selected.find((product) => product.category.toLowerCase() === "graphics card");
  const editingGpuSuitable = (product: ProductCandidate | undefined) => Boolean(product && /\b(RTX|Radeon\s+RX|Intel\s+Arc)\b/i.test(product.name) && Number(product.name.match(/\b(6|8|12|16|20|24)GB\b/i)?.[1] ?? 0) >= 6);
  if (performanceWorkload && !editingGpuSuitable(gpu)) {
    const replacement = state.products.filter((product) => product.category.toLowerCase() === "graphics card" && editingGpuSuitable(product)).sort((a, b) => a.price - b.price)[0];
    if (replacement && gpu) { selected = selected.map((product) => product.id === gpu!.id ? replacement : product); gpu = replacement; }
  }
  let total = selected.reduce((sum, product) => sum + product.price, 0);
  if (total > budget) {
    for (const category of performanceWorkload ? ["cpu", "graphics card", "casing", "ssd", "power supply"] : ["graphics card", "casing", "ssd", "power supply"]) {
      const current = selected.find((product) => product.category.toLowerCase() === category);
      if (!current) continue;
      const replacement = state.products.filter((product) => {
        if (product.category.toLowerCase() !== category || product.price >= current.price) return false;
        if (category === "cpu" && motherboard) return cpuVendor === "amd" ? amdCpuSocket(product.name) === amdBoardSocket(motherboard.name) : cpuVendor === "intel" ? intelCpuSocket(product.name) === intelBoardSocket(motherboard.name) : false;
        if (category === "graphics card" && performanceWorkload) return /\b(RTX|Radeon\s+RX|Intel\s+Arc)\b/i.test(product.name) && Number(product.name.match(/\b(6|8|12|16|20|24)GB\b/i)?.[1] ?? 0) >= 6;
        return true;
      }).sort((a, b) => a.price - b.price)[0];
      if (replacement) {
        selected = selected.map((product) => product.id === current.id ? replacement : product);
        total = selected.reduce((sum, product) => sum + product.price, 0);
      }
      if (total <= budget) break;
    }
  }
  const complete = required.every((category) => selected.some((product) => product.category.toLowerCase() === category));
  const platformCompatible = !cpu || !motherboard || (cpuVendor === "amd" ? boardVendor(motherboard.name) === "amd" && (!amdCpuSocket(cpu.name) || amdCpuSocket(cpu.name) === amdBoardSocket(motherboard.name)) : cpuVendor === "intel" ? boardVendor(motherboard.name) === "intel" && (!intelCpuSocket(cpu.name) || intelCpuSocket(cpu.name) === intelBoardSocket(motherboard.name)) : false);
  const memoryCompatible = !memoryGeneration || !ram || ram.name.toUpperCase().includes(memoryGeneration);
  const passed = complete && total <= budget && selected.every((product) => allowed.has(product.id)) && platformCompatible && memoryCompatible;
  const build = selected.map((product) => ({ ...product, reason: `Selected from the live ${product.category} catalog for this budget.` }));
  const warnings = [
    ...(state.manual.length ? [] : ["No PC-build manual has been ingested yet; manual-based compatibility retrieval was unavailable."]),
    ...(state.web.length ? [] : ["Live web context was unavailable; verify the game's current official requirements."]),
    ...(!memoryGeneration ? ["The motherboard memory generation could not be determined from catalog text."] : []),
    ...(!platformCompatible ? ["No motherboard candidate matching the selected CPU platform/socket was available; the build was withheld."] : []),
    ...(targetRam && (!ram || ramCapacity(ram.name) < targetRam) ? [`No suitable ${targetRam} GB memory product was available inside the retrieved budget range.`] : []),
    ...(performanceWorkload && !editingGpuSuitable(gpu) ? ["No modern graphics card with at least 6 GB VRAM was available inside the retrieved budget range."] : []),
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
