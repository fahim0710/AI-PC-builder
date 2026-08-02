import { pool } from "../db/pool.js";
import { embed } from "./huggingface.js";

export type ProductCandidate = {
  id: string; name: string; category: string; price: number; description: string;
  specifications: unknown; imageUrl: string | null; sourceUrl: string;
  rank?: number; cheapRank?: number;
};

const cosine = (left: number[], right: number[]) => {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0, a = 0, b = 0;
  for (let index = 0; index < left.length; index++) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2; }
  return a && b ? dot / (Math.sqrt(a) * Math.sqrt(b)) : 0;
};

export async function retrieveManual(query: string, limit = 5) {
  const chunks = await pool.query<{ id: string; content: string; embedding: number[] | null; title: string }>(
    `SELECT kc.id::text, kc.content, kc.embedding, kd.title
     FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id`,
  );
  if (!chunks.rowCount) return [];
  let queryEmbedding: number[] = [];
  try { queryEmbedding = await embed(query); } catch { /* lexical fallback below */ }
  const words = new Set(query.toLowerCase().split(/\W+/).filter((word) => word.length > 2));
  return chunks.rows.map((chunk) => {
    const lexical = [...words].filter((word) => chunk.content.toLowerCase().includes(word)).length / Math.max(words.size, 1);
    const vector = chunk.embedding && queryEmbedding.length ? cosine(queryEmbedding, chunk.embedding) : 0;
    return { ...chunk, score: vector || lexical, source: `Manual: ${chunk.title}` };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function retrieveProducts(budget: number): Promise<ProductCandidate[]> {
  const result = await pool.query(
    `WITH ranked AS (
       SELECT p.id::text, p.name, c.name AS category, p.price_bdt AS price,
              p.description, p.specifications, p.image_url AS "imageUrl",
              p.source_product_url AS "sourceUrl",
              ROW_NUMBER() OVER (PARTITION BY c.name, CASE
                WHEN LOWER(c.name) = 'ram' THEN
                  (CASE WHEN p.name ILIKE '%DDR5%' THEN 'ddr5' WHEN p.name ILIKE '%DDR4%' THEN 'ddr4' ELSE 'other' END) || '-' ||
                  (CASE WHEN p.name ~* '(32[[:space:]]*GB|2[[:space:]]*[xX][[:space:]]*16)' THEN '32gb' WHEN p.name ~* '(16[[:space:]]*GB|2[[:space:]]*[xX][[:space:]]*8)' THEN '16gb' ELSE 'other' END)
                WHEN LOWER(c.name) = 'cpu' THEN CASE WHEN p.name ~* '(amd|ryzen)' THEN 'amd' WHEN p.name ~* 'intel' THEN 'intel' ELSE 'other' END
                WHEN LOWER(c.name) = 'motherboard' THEN CASE
                  WHEN p.name ~* '(am5|a620|b650|b840|x670|x870)' THEN 'amd-am5'
                  WHEN p.name ~* '(am4|a320|a520|b350|b450|b550|x370|x470|x570)' THEN 'amd-am4'
                  WHEN p.name ~* '(lga1700|h610|h670|h710|h770|b660|b760|z690|z790)' THEN 'intel-lga1700'
                  WHEN p.name ~* '(lga1200|h410|h470|h510|h570|b460|b560|z490|z590)' THEN 'intel-lga1200'
                  WHEN p.name ~* '(intel|h61|h81|h110|h170|h270|h310|b150|b250|b360|z170|z270|z370|z390|lga1151)' THEN 'intel-legacy'
                  ELSE 'other' END
                ELSE 'all' END
              ORDER BY ABS(p.price_bdt - CASE LOWER(c.name)
                WHEN 'cpu' THEN $1 * 0.18 WHEN 'motherboard' THEN $1 * 0.13
                WHEN 'ram' THEN $1 * 0.08 WHEN 'graphics card' THEN $1 * 0.38
                WHEN 'ssd' THEN $1 * 0.08 WHEN 'power supply' THEN $1 * 0.07
                WHEN 'casing' THEN $1 * 0.06 ELSE $1 * 0.04 END)) AS rank
              , ROW_NUMBER() OVER (PARTITION BY c.name, CASE
                  WHEN LOWER(c.name) = 'graphics card' AND p.name ~* '(RTX|Radeon[[:space:]]+RX|Intel[[:space:]]+Arc).*(6GB|8GB|12GB|16GB)' THEN 'workstation-gpu'
                  ELSE 'general' END ORDER BY p.price_bdt ASC) AS "cheapRank"
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = TRUE AND (
         (LOWER(c.name) = 'cpu' AND p.price_bdt <= $1 * 0.23) OR
         (LOWER(c.name) = 'motherboard' AND p.price_bdt <= $1 * 0.17) OR
         (LOWER(c.name) = 'ram' AND (p.price_bdt <= $1 * 0.16
           OR (p.name ~* '(16[[:space:]]*GB|2[[:space:]]*[xX][[:space:]]*8)' AND p.price_bdt <= $1 * 0.25)
           OR (p.name ~* '(32[[:space:]]*GB|2[[:space:]]*[xX][[:space:]]*16)' AND p.price_bdt <= $1 * 0.35))) OR
         (LOWER(c.name) = 'graphics card' AND p.price_bdt <= $1 * 0.48) OR
         (LOWER(c.name) = 'ssd' AND p.price_bdt <= $1 * 0.11) OR
         (LOWER(c.name) = 'power supply' AND p.price_bdt <= $1 * 0.10) OR
         (LOWER(c.name) = 'casing' AND p.price_bdt <= $1 * 0.09) OR
         (LOWER(c.name) = 'cpu cooler' AND p.price_bdt <= $1 * 0.06)
       )
     ) SELECT * FROM ranked WHERE rank <= 4 OR "cheapRank" <= 2 ORDER BY category, price DESC`,
    [budget],
  );
  return result.rows as ProductCandidate[];
}

export async function searchCatalog(query: string, limit = 12, maximumPrice?: number | null): Promise<ProductCandidate[]> {
  const stopWords = new Set(["what", "price", "cost", "of", "a", "an", "the", "show", "suggest", "recommend", "me", "find", "available", "availability", "product", "products", "processor", "processors", "component", "components", "under", "within", "budget", "taka", "bdt", "tk", "follow", "up", "request", "then", "instead", "please", "pls"]);
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 1 && !/^\d+$/.test(term) && !stopWords.has(term)).slice(0, 6);
  const values: unknown[] = [];
  const filters = terms.map((term) => { values.push(`%${term}%`); return `(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length} OR p.specifications::text ILIKE $${values.length})`; });
  const categoryHint = /\b(cpu|processor|processors)\b/i.test(query) ? "cpu" : /\b(gpu|graphics card)\b/i.test(query) ? "graphics card" : /\b(ram|memory)\b/i.test(query) ? "ram" : /\b(ssd|storage)\b/i.test(query) ? "ssd" : /\bmotherboard\b/i.test(query) ? "motherboard" : null;
  if (categoryHint) { values.push(categoryHint); filters.push(`LOWER(c.name) = $${values.length}`); }
  if (maximumPrice) { values.push(maximumPrice); filters.push(`p.price_bdt <= $${values.length}`); }
  values.push(limit);
  const result = await pool.query(
    `SELECT p.id::text, p.name, c.name AS category, p.price_bdt AS price,
            p.description, p.specifications, p.image_url AS "imageUrl", p.source_product_url AS "sourceUrl"
     FROM products p JOIN categories c ON c.id = p.category_id
     WHERE p.is_active = TRUE ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
     ORDER BY p.price_bdt ${maximumPrice ? "DESC" : "ASC"} LIMIT $${values.length}`,
    values,
  );
  return result.rows as ProductCandidate[];
}

export async function searchWeb(query: string) {
  if (process.env.AI_WEB_SEARCH_ENABLED === "false") return [];
  const cleanHtml = (value: string) => value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  try {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query); url.searchParams.set("format", "json"); url.searchParams.set("no_html", "1"); url.searchParams.set("skip_disambig", "1");
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "NexRig-PC-Builder/1.0" } });
    if (!response.ok) return [];
    const data = await response.json() as { AbstractText?: string; AbstractURL?: string; AbstractSource?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
    const results = [] as Array<{ title: string; url: string; snippet: string }>;
    if (data.AbstractText && data.AbstractURL) results.push({ title: data.AbstractSource ?? "Web result", url: data.AbstractURL, snippet: data.AbstractText });
    for (const topic of data.RelatedTopics?.slice(0, 4) ?? []) if (topic.Text && topic.FirstURL) results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
    if (results.length) return results;
  } catch { /* continue to structured game-source fallback */ }
  try {
    const aliasedQuery = query.replace(/\bgta\s*(?:v|5)\b/gi, "Grand Theft Auto V");
    const term = /\bGrand Theft Auto V\b/i.test(aliasedQuery) ? "Grand Theft Auto V" : aliasedQuery
      .replace(/\b(system|requirements?|recommended|specifications?|specs?|official|gaming|game|pc|build|budget|under|within|bdt|taka|fps)\b/gi, " ")
      .replace(/\b\d{4,8}\b|\b\d{3,4}p\b|৳/gi, " ").replace(/\s+/g, " ").trim();
    const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=us`;
    const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    const searchData = await searchResponse.json() as { items?: Array<{ id: number; name: string }> };
    const game = searchData.items?.[0];
    if (game) {
      const detailResponse = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.id}&l=english&cc=us`, { signal: AbortSignal.timeout(8000) });
      const detailData = await detailResponse.json() as Record<string, { success: boolean; data?: { pc_requirements?: { minimum?: string; recommended?: string } } }>;
      const requirements = detailData[String(game.id)]?.data?.pc_requirements;
      const results = [] as Array<{ title: string; url: string; snippet: string }>;
      if (requirements?.minimum) results.push({ title: `${game.name} minimum PC requirements`, url: `https://store.steampowered.com/app/${game.id}`, snippet: cleanHtml(requirements.minimum) });
      if (requirements?.recommended) results.push({ title: `${game.name} recommended PC requirements`, url: `https://store.steampowered.com/app/${game.id}`, snippet: cleanHtml(requirements.recommended) });
      if (results.length) return results;
    }
  } catch { /* internet context remains optional and is disclosed by guardrails */ }
  return [];
}
