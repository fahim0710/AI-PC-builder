import "dotenv/config";
import { runPcBuilder, type AiResult } from "../ai/graph.js";

type Case = {
  name: string;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  check: (result: AiResult) => string[];
};

const required = ["cpu", "motherboard", "ram", "graphics card", "ssd", "power supply", "casing"];
const capacity = (name: string) => Number(name.match(/\b(8|16|32|48|64|96|128)\s*GB\b/i)?.[1] ?? 0);
const completeBuild = (result: AiResult) => required.filter((category) => !result.build.some((item) => item.category.toLowerCase() === category)).map((category) => `missing ${category}`);
const grounded = (result: AiResult) => result.build.filter((item) => !/^\d+$/.test(item.id)).map((item) => `invalid product id ${item.id}`);
const withinBudget = (result: AiResult) => result.budget && result.total > result.budget ? [`total ${result.total} exceeds ${result.budget}`] : [];
const performanceIssues = (result: AiResult, minimumRam: number) => {
  const ram = result.build.find((item) => item.category.toLowerCase() === "ram");
  const gpu = result.build.find((item) => item.category.toLowerCase() === "graphics card");
  const gpuMemory = Number(gpu?.name.match(/\b(1|2|4|6|8|12|16|20|24)GB\b/i)?.[1] ?? 0);
  return [...(!ram || capacity(ram.name) < minimumRam ? [`less than ${minimumRam} GB RAM`] : []), ...(!gpu || !/RTX|Radeon\s+RX|Intel\s+Arc/i.test(gpu.name) || gpuMemory < 6 ? ["lacks a modern GPU with at least 6 GB VRAM"] : [])];
};

const cases: Case[] = [
  {
    name: "Gaming build / k budget",
    question: "Build me a GTA V PC under 100k BDT for 1080p 60 FPS",
    check: (result) => [...completeBuild(result), ...grounded(result), ...withinBudget(result), ...performanceIssues(result, 16), ...(result.budget === 100_000 ? [] : [`budget parsed as ${result.budget}`])],
  },
  {
    name: "Video editing workload",
    question: "I edit 4K video in Premiere Pro. Suggest a workstation under 150000 taka",
    check: (result) => {
      return [...completeBuild(result), ...grounded(result), ...withinBudget(result), ...performanceIssues(result, 32)];
    },
  },
  {
    name: "Conversation revision / Intel to AMD",
    question: "Can you change the Intel processor to AMD under the same budget?",
    history: [
      { role: "user", content: "I am a video editor. Suggest a good build under 150k taka" },
      { role: "assistant", content: "I recommended an Intel video-editing build within your budget." },
    ],
    check: (result) => {
      const cpu = result.build.find((item) => item.category.toLowerCase() === "cpu");
      const board = result.build.find((item) => item.category.toLowerCase() === "motherboard");
      return [...completeBuild(result), ...withinBudget(result), ...performanceIssues(result, 32), ...(!cpu || !/amd|ryzen/i.test(cpu.name) ? ["CPU was not changed to AMD"] : []), ...(!board || !/amd|am4|am5|a320|a520|a620|b450|b550|b650|b840|x570|x670|x870/i.test(board.name) ? ["motherboard does not appear to be AMD platform"] : [])];
    },
  },
  {
    name: "Lakh budget parsing",
    question: "Recommend a balanced gaming PC within 1.2 lakh",
    check: (result) => [...completeBuild(result), ...withinBudget(result), ...performanceIssues(result, 16), ...(result.budget === 120_000 ? [] : [`budget parsed as ${result.budget}`])],
  },
  {
    name: "Missing budget clarification",
    question: "Suggest a good PC build for Blender",
    check: (result) => [...(result.build.length ? ["returned products without a budget"] : []), ...(!/budget/i.test(result.answer) ? ["did not ask for a budget"] : [])],
  },
  {
    name: "Catalog product lookup",
    question: "Show me available Ryzen processors",
    check: (result) => [...(!result.build.length ? ["no catalog matches"] : []), ...result.build.filter((item) => !/ryzen|amd/i.test(item.name)).map((item) => `irrelevant match: ${item.name}`), ...grounded(result)],
  },
  {
    name: "Budgeted graphics-card lookup",
    question: "Suggest me graphics card under 20000 taka",
    check: (result) => [...(!result.build.length ? ["no graphics-card matches"] : []), ...result.build.filter((item) => item.category.toLowerCase() !== "graphics card").map((item) => `wrong category: ${item.category}`), ...result.build.filter((item) => item.price > 20_000).map((item) => `over budget: ${item.name}`), ...grounded(result)],
  },
  {
    name: "Budget-only product follow-up",
    question: "100000 taka then",
    history: [
      { role: "user", content: "Suggest me graphics card under 20000 taka" },
      { role: "assistant", content: "I could not find a graphics card in that range." },
    ],
    check: (result) => [...(!result.build.length ? ["no graphics-card matches"] : []), ...result.build.filter((item) => item.category.toLowerCase() !== "graphics card").map((item) => `lost product intent: ${item.category}`), ...result.build.filter((item) => item.price > 100_000).map((item) => `over revised budget: ${item.name}`)],
  },
  {
    name: "Impossible low budget",
    question: "Build a complete gaming PC under 20000 BDT",
    check: (result) => [...(result.guardrails.passed && result.build.length ? ["claimed a complete valid build at an unrealistic budget"] : []), ...(result.total > 20_000 ? ["returned an over-budget total"] : [])],
  },
];

const requestedCases = process.argv.slice(2).map((value) => value.toLowerCase());
const activeCases = requestedCases.length ? cases.filter((testCase) => requestedCases.some((value) => testCase.name.toLowerCase().includes(value))) : cases;
let failures = 0;
for (const testCase of activeCases) {
  const started = Date.now();
  try {
    const result = await runPcBuilder(testCase.question, testCase.history ?? []);
    const issues = testCase.check(result);
    failures += issues.length ? 1 : 0;
    console.log(JSON.stringify({ case: testCase.name, passed: !issues.length, issues, ms: Date.now() - started, budget: result.budget, total: result.total, answer: result.answer, products: result.build.map((item) => `${item.category}: ${item.name}`), warnings: result.guardrails.warnings }, null, 2));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ case: testCase.name, passed: false, issues: [error instanceof Error ? error.message : String(error)], ms: Date.now() - started }, null, 2));
  }
}

console.log(JSON.stringify({ summary: { total: activeCases.length, passed: activeCases.length - failures, failed: failures } }, null, 2));
process.exitCode = failures ? 1 : 0;
