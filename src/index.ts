import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// Escape LIKE special characters in user input to prevent wildcard injection
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

const MAX_QUERY_LENGTH = 120;
const MAX_QUERY_INPUT_LENGTH = 200;
const MAX_NAME_LENGTH = 50;
const MAX_BATCH_INPUT_LENGTH = 4_000;
const MAX_INGREDIENTS = 60;
const MAX_SEARCH_RESULTS = 25;
const MAX_MRL_RESULTS = 20;
const FOOD_MARKETS = ["EU", "US", "Israel", "IL", "EU + US"] as const;
const FOOD_SEARCH_FILTERS = ["high_risk", "allergens", "banned", "not_vegan", "not_halal"] as const;

function normalizeQuery(input: string, maxLength = MAX_QUERY_LENGTH): string {
  return input.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function likePattern(input: string): string {
  return `%${escapeLike(input)}%`;
}

const RATE_LIMIT_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_PER_MINUTE) return false;
  return true;
}

function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: "Rate limit exceeded. Maximum 60 requests per minute." }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
}

interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  // Optional auth env. When configured, validates Bearer tokens for per-user rate limiting.
  MCP_KEY_SECRET?: string;
}

// --- Auth: HMAC-validated MCP key ---
// MCP keys are issued by rootsbybenda-site/functions/api/mcp-key.js using the
// SAME MCP_KEY_SECRET. Format: mcp_<base64url(user_id)>_<sha256_hmac[:32]>.

interface AuthProps extends Record<string, unknown> {
  user_id: string | null;
  authenticated: boolean;
}

function base64urlDecodeToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  return atob(padded);
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function resolveAuth(request: Request, env: Env): Promise<AuthProps> {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(mcp_[A-Za-z0-9_-]+_[a-f0-9]{32})\s*$/i);
  if (!match) return { user_id: null, authenticated: false };

  const key = match[1];
  const parts = key.split("_");
  if (parts.length !== 3 || parts[0] !== "mcp") {
    return { user_id: null, authenticated: false };
  }
  const userIdB64 = parts[1];
  const providedHmac = parts[2].toLowerCase();

  if (!env.MCP_KEY_SECRET) {
    console.error("resolveAuth: MCP_KEY_SECRET not configured");
    return { user_id: null, authenticated: false };
  }

  let userId: string;
  try {
    userId = base64urlDecodeToString(userIdB64);
  } catch {
    return { user_id: null, authenticated: false };
  }
  if (!userId) return { user_id: null, authenticated: false };

  const computed = (await hmacSha256Hex(userId, env.MCP_KEY_SECRET)).slice(0, 32);
  if (!constantTimeEqual(computed, providedHmac)) {
    return { user_id: null, authenticated: false };
  }

  return { user_id: userId, authenticated: true };
}
// --- End auth ---

const SERVER_VERSION = "1.0.2";
const HOMEPAGE = "https://rootsbybenda.com";
const SOURCE = "Roots by Benda \u2014 rootsbybenda.com";
const CONTACT = "support@rootsbybenda.com";
const SERVER_NAME = "Roots by Benda \u2014 Food Intelligence";
const SERVER_DESCRIPTION =
  "Food additive safety regulatory reference data: verified safety scores, ADI values, JECFA/EFSA evaluations, allergen and dietary flags, EU/US/Israel regulatory status, Israeli nutrition profiles, and pesticide MRL limits. 6,450+ additives, 6,563 JECFA evaluations, 5,251 EFSA substances, 77,278 synonyms, 4,624 nutrition profiles, 3,708 pesticide MRLs.";
const DATA_CATALOG = {
  food_additives: "6,450+",
  jecfa_evaluations: "6,563+",
  efsa_substances: "5,251+",
  food_synonyms: "77,278+",
  israeli_permitted: "319",
  nutrition_profiles: "4,624",
  pesticide_mrls: "3,708"
};
const TOOL_CATALOG = [
  {
    name: "check_additive",
    description: "Retrieve verified food additive safety data including toxicological evaluations, regulatory status, and dietary compatibility from 6,450+ food additive records. Input: additive common name, E-number, or CAS number (e.g. 'aspartame', 'E951', '22839-47-0'). Returns: safety score (1-10 scale), ADI (Acceptable Daily Intake) with source, JECFA evaluation history (ADI status, functional class, evaluation year), EFSA toxicology data (ADI/TDI/NOAEL values, genotoxicity), EU and US regulatory status, Israel MOH permitted-additive status, IARC classification, health concerns, allergen flags, dietary compatibility (vegan, halal, kosher, diabetic), PubChem chemistry data, common foods, and banned-country list. Sources: JECFA (6,563 evaluations), EFSA (5,251 substances), EU food additive regulations, US FDA GRAS, Israel MOH, IARC. For food additive safety assessment and regulatory compliance. Do not use for full ingredient-list scans (use check_ingredient_list), nutrition queries (use check_nutrition), or pesticide MRLs (use check_pesticide_mrl)."
  },
  {
    name: "check_ingredient_list",
    description: "Scan a packaged-food product ingredient list for additive safety risks, regulatory compliance, allergens, and dietary compatibility across target markets. Input: comma-separated ingredient list as printed on food packaging (up to 60 ingredients). Returns per-ingredient: matched additive name, E-number, safety score (1-10), category, EU/US status, health concerns, allergen flags, and ADI. Returns overall: LOW/MODERATE/HIGH risk assessment, average safety score, flagged high-risk additives with reasons and banned-country data, allergen warnings, and market-specific compliance notes. Database: 6,450+ food additives with 77,278 synonyms for fuzzy matching. For food product safety screening and market compliance. Do not use for single additive lookup (use check_additive), nutrition facts (use check_nutrition), or pesticide MRLs (use check_pesticide_mrl)."
  },
  {
    name: "search_additives",
    description: "Search food additive records by keyword, function, category, dietary filter, or health concern for additive discovery and selection. Input: food additive keyword (e.g. 'preservative', 'sweetener', 'hyperactivity', 'banned', 'E1') with optional filter (high_risk, allergens, banned, not_vegan, not_halal). Returns: matching additive names, E-numbers, CAS numbers, Hebrew names, categories, functions, safety scores (1-10), EU/US status, health concerns, allergen flags, dietary status (vegan/halal/kosher), and ADI values. Database: 6,450+ food additives searchable by name, function, category, and Hebrew name. For food additive discovery and category exploration. Do not use when the user has an exact additive name/E-number for full safety data (use check_additive)."
  },
  {
    name: "check_nutrition",
    description: "Retrieve Israeli Ministry of Health official nutrition data for a food item by name in Hebrew or English. Input: food name (e.g. 'hummus', 'chicken breast', 'bread', or Hebrew equivalent). Returns per 100g: energy (kcal), protein, total fat, carbohydrates, dietary fiber, total sugars, alcohol, moisture; vitamins (A, C, E, D, K, B6, B12, thiamin, riboflavin, niacin, folate); minerals (calcium, iron, magnesium, phosphorus, zinc, selenium, sodium, potassium, choline); fats (cholesterol, saturated, mono/polyunsaturated, trans). Source: Israel Ministry of Health Nutrition Database (4,624 food items). For nutritional analysis and dietary reference. Do not use for additive safety (use check_additive) or pesticide MRLs (use check_pesticide_mrl)."
  },
  {
    name: "check_pesticide_mrl",
    description: "Check Israeli official pesticide Maximum Residue Limits (MRL) by pesticide active substance, crop, or pesticide-crop pair. Input: pesticide name, crop name, or combined query in Hebrew or English (e.g. 'glyphosate', 'tomato', 'chlorpyrifos apple'). Returns: active substance, crop (Hebrew and English), official MRL value in mg/kg (ppm), last update date, and pending regulatory changes. Source: Israel Ministry of Health Pesticide Residue Limits (3,708 pesticide-crop MRL records). For agricultural compliance and food safety residue assessment. Do not use for food additive safety (use check_additive), cannabis pesticide limits, or non-Israeli MRL regimes."
  }
];

function registryMetadata() {
  return {
    name: SERVER_NAME,
    description: SERVER_DESCRIPTION,
    version: SERVER_VERSION,
    mcp_endpoint: "/mcp",
    tools: TOOL_CATALOG,
    data: DATA_CATALOG,
    homepage: HOMEPAGE,
    source: SOURCE,
    contact: CONTACT,
  };
}


export class FoodMCP extends McpAgent<Env> {
  // @ts-expect-error agents bundles its own MCP SDK copy; runtime server shape is compatible.
  server = new McpServer({
    name: "roots-food-safety",
    version: SERVER_VERSION,
  });

  async init() {
    // Tool 1: check_additive — lookup by name, E-number, or CAS number
    this.server.tool(
      "check_additive",
      TOOL_CATALOG[0].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Food additive common name (e.g. 'aspartame'), E-number used in EU-style food labeling (e.g. 'E951'), INS number where applicable, or CAS number (Chemical Abstracts Service registry number, e.g. '22839-47-0'). E-number or exact additive name is preferred for regulatory matching."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query }) => {
        const q = normalizeQuery(query);

        // Try E-number match first
        let additive = await this.env.DB.prepare(
          `SELECT * FROM food_additives WHERE e_number = ? COLLATE NOCASE`
        )
          .bind(q.toUpperCase().replace(/\s+/g, ""))
          .first();

        // Try CAS number
        if (!additive) {
          additive = await this.env.DB.prepare(
            `SELECT * FROM food_additives WHERE cas_number = ? COLLATE NOCASE`
          )
            .bind(q)
            .first();
        }

        // Try exact common name
        if (!additive) {
          additive = await this.env.DB.prepare(
            `SELECT * FROM food_additives WHERE common_name = ? COLLATE NOCASE`
          )
            .bind(q)
            .first();
        }

        // Try fuzzy name match
        if (!additive) {
          additive = await this.env.DB.prepare(
            `SELECT * FROM food_additives WHERE common_name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(likePattern(q))
            .first();
        }

        // Try synonyms table
        if (!additive) {
          const synonym = await this.env.DB.prepare(
            `SELECT additive_id FROM food_synonyms WHERE synonym LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(likePattern(q))
            .first();

          if (synonym) {
            additive = await this.env.DB.prepare(
              `SELECT * FROM food_additives WHERE id = ?`
            )
              .bind(synonym.additive_id)
              .first();
          }
        }

        if (!additive) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "not_found",
                  message: `No food additive found matching "${query}". Try searching by E-number (e.g. 'E200') or common name (e.g. 'sorbic acid').`,
                }),
              },
            ],
          };
        }

        // Get JECFA evaluation if available
        const commonNameEsc = escapeLike((additive.common_name as string) || "");
        const jecfa = await this.env.DB.prepare(
          `SELECT adi_raw, adi_upper, adi_status, functional_class, evaluation_year
           FROM jecfa_adi
           WHERE chemical_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR cas_number = ?
           LIMIT 3`
        )
          .bind(
            `%${commonNameEsc}%`,
            (additive.cas_number as string) || ""
          )
          .all();

        // Get EFSA toxicology data if available
        const efsa = await this.env.DB.prepare(
          `SELECT substance_name, adi_value, adi_unit, tdi_value, tdi_unit,
                  noael_value, noael_unit, genotoxicity
           FROM food_substances
           WHERE substance_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR cas_number = ?
           LIMIT 3`
        )
          .bind(
            `%${commonNameEsc}%`,
            (additive.cas_number as string) || ""
          )
          .all();

        // Check Israeli regulatory status
        const ilStatus = await this.env.DB.prepare(
          `SELECT e_number, name_en, additive_type, status, notes
           FROM il_permitted_additives
           WHERE e_number = ? COLLATE NOCASE
           LIMIT 1`
        )
          .bind((additive.e_number as string) || "")
          .first();

        const result: Record<string, unknown> = {
          name: additive.common_name,
          e_number: additive.e_number || null,
          chemical_name: additive.chemical_name || null,
          cas_number: additive.cas_number || null,
          hebrew_name: additive.hebrew_name || null,
          category: additive.category,
          function: additive.function_desc,
          source_type: additive.source_type,
          data_freshness: {
            database_version: "2026-05",
            source_type: "food_additive_safety_regulatory_reference_data",
          },
          safety_score: additive.safety_score,
          safety_score_scale: "1 (safest) to 10 (most concerning)",
          chemistry: {
            pubchem_cid: additive.pubchem_cid || null,
            molecular_formula: additive.molecular_formula || null,
            molecular_weight: additive.molecular_weight || null,
            iupac_name: additive.iupac_name || null,
            inchikey: additive.inchikey || null,
            xlogp: additive.xlogp || null,
          },
          adi: {
            value: additive.adi_value,
            unit: additive.adi_unit,
            source: additive.adi_source || "JECFA/EFSA ADI evaluation",
          },
          regulatory: {
            eu_status: { value: additive.eu_status, source: "EU food additive regulations" },
            us_status: { value: additive.us_status, source: "US FDA GRAS / food additive status" },
            max_permitted_level_ppm: additive.max_permitted_level_ppm || null,
            banned_countries: additive.banned_countries || null,
            israel: ilStatus
              ? {
                  status: ilStatus.status,
                  type: ilStatus.additive_type,
                  notes: ilStatus.notes,
                  source: "Israel MOH Permitted Food Additives",
                }
              : null,
          },
          health: {
            concerns: additive.health_concerns,
            allergen: additive.allergen_flag,
            iarc_group: { value: additive.iarc_group || null, source: additive.iarc_group ? "IARC Monographs" : null },
            hyperactivity_link: additive.hyperactivity_link || null,
            pregnancy_safe: additive.pregnancy_safe || null,
            children_safe: additive.children_safe || null,
          },
          dietary: {
            vegan: additive.vegan || null,
            halal: additive.halal || null,
            kosher: additive.kosher || null,
            diabetic_suitable: additive.diabetic_suitable || null,
            glycemic_index: additive.glycemic_index || null,
          },
          common_foods: additive.common_foods || null,
          jecfa_evaluations:
            jecfa.results?.map((j: Record<string, unknown>) => ({
              adi: j.adi_raw,
              adi_upper: j.adi_upper,
              status: j.adi_status,
              functional_class: j.functional_class,
              evaluation_year: j.evaluation_year,
              source: "JECFA (Joint FAO/WHO Expert Committee on Food Additives)",
            })) || [],
          efsa_data:
            efsa.results?.map((e: Record<string, unknown>) => ({
              adi: e.adi_value ? `${e.adi_value} ${e.adi_unit}` : null,
              tdi: e.tdi_value ? `${e.tdi_value} ${e.tdi_unit}` : null,
              noael: e.noael_value
                ? `${e.noael_value} ${e.noael_unit}`
                : null,
              genotoxicity: e.genotoxicity,
              source: "EFSA (European Food Safety Authority)",
            })) || [],
          source: "Roots by Benda — rootsbybenda.com",
        };

        // Build citation_ready
        // K76: conditional source attribution — only authorities that actually contributed data
        const citAdditiveId = [additive.common_name, additive.e_number ? `(${additive.e_number})` : null, additive.cas_number ? `CAS ${additive.cas_number}` : null].filter(Boolean).join(" ");
        const citParts: string[] = [];
        const sourcesUsed = new Set<string>();
        if (additive.safety_score) {
          citParts.push(`safety score ${additive.safety_score}/10`);
          sourcesUsed.add("Roots curated");
        }
        if (additive.adi_value) {
          citParts.push(`ADI ${additive.adi_value} ${additive.adi_unit || ""}`);
          sourcesUsed.add("JECFA/EFSA"); // ADI databases — can't disambiguate per-row without source linkage
        }
        if (additive.eu_status) {
          citParts.push(`EU: ${additive.eu_status}`);
          sourcesUsed.add("EU food regulation");
        }
        if (additive.us_status) {
          citParts.push(`US: ${additive.us_status}`);
          sourcesUsed.add("US FDA");
        }
        if (ilStatus) {
          citParts.push(`Israel: ${ilStatus.status}`);
          sourcesUsed.add("Israel MoH");
        }
        const sourcesArr = Array.from(sourcesUsed).sort();
        const sourceTail = sourcesArr.length > 0
          ? ` — sourced from ${sourcesArr.join(", ")}`
          : "";
        result.citation_ready = `${citAdditiveId}: ${citParts.join("; ")}. Source: Roots by Benda (rootsbybenda.com)${sourceTail}.`;

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    );

    // Tool 2: check_ingredient_list — batch check a list of food ingredients
    this.server.tool(
      "check_ingredient_list",
      TOOL_CATALOG[1].description,
      {
        ingredients: z
          .string()
          .trim()
          .min(1)
          .max(MAX_BATCH_INPUT_LENGTH)
          .describe(
            "Comma-separated or newline-separated packaged-food ingredient list exactly as it appears on a label (e.g. 'Water, Sugar, Citric Acid, Sodium Benzoate, Aspartame'). Include additives, colors, preservatives, and E-numbers; the tool scans up to configured batch limits for safety and compliance flags."
          ),
        market: z
          .enum(FOOD_MARKETS)
          .optional()
          .describe(
            "Optional target food regulatory market for compliance focus. Use 'EU', 'US', or 'Israel' when the user asks about a specific market; omit for the default EU + US scan."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ ingredients, market }) => {
        const names = ingredients
          .split(/[,\n]+/)
          .map((n) => normalizeQuery(n, MAX_NAME_LENGTH))
          .filter(Boolean);

        if (names.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "empty_list",
                  message: "No ingredients provided.",
                }),
              },
            ],
          };
        }

        if (names.length > MAX_INGREDIENTS) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "too_many",
                  message:
                    `Maximum ${MAX_INGREDIENTS} ingredients per request. Split into multiple calls.`,
                }),
              },
            ],
          };
        }

        const results: Record<string, unknown>[] = [];
        const flagged: Record<string, unknown>[] = [];
        const allergens: Record<string, unknown>[] = [];
        let found = 0;
        let notFound = 0;

        for (const name of names) {
          // Try exact match, then fuzzy
          let additive = await this.env.DB.prepare(
            `SELECT id, common_name, e_number, cas_number, safety_score, eu_status, us_status,
                    health_concerns, allergen_flag, category, adi_value, adi_unit,
                    banned_countries, hyperactivity_link, children_safe, pregnancy_safe
             FROM food_additives
             WHERE common_name = ? COLLATE NOCASE
                OR e_number = ? COLLATE NOCASE
             LIMIT 1`
          )
            .bind(name, name.toUpperCase().replace(/\s+/g, ""))
            .first();

          if (!additive) {
            additive = await this.env.DB.prepare(
              `SELECT id, common_name, e_number, cas_number, safety_score, eu_status, us_status,
                      health_concerns, allergen_flag, category, adi_value, adi_unit,
                      banned_countries, hyperactivity_link, children_safe, pregnancy_safe
               FROM food_additives
               WHERE common_name LIKE ? ESCAPE '\\' COLLATE NOCASE
               LIMIT 1`
            )
              .bind(likePattern(name))
              .first();
          }

          if (additive) {
            found++;
            const entry: Record<string, unknown> = {
              input: name,
              matched: additive.common_name,
              e_number: additive.e_number || null,
              safety_score: additive.safety_score,
              category: additive.category,
              eu_status: additive.eu_status,
              us_status: additive.us_status,
              health_concerns: additive.health_concerns,
              allergen: additive.allergen_flag,
              adi: additive.adi_value
                ? `${additive.adi_value} ${additive.adi_unit}`
                : null,
            };

            results.push(entry);

            if ((additive.safety_score as number) >= 7) {
              flagged.push({
                name: additive.common_name,
                e_number: additive.e_number,
                score: additive.safety_score,
                reason: additive.health_concerns,
                banned_in: additive.banned_countries || null,
              });
            }

            if (additive.allergen_flag !== "no" && additive.allergen_flag) {
              allergens.push({
                name: additive.common_name,
                allergen_info: additive.allergen_flag,
              });
            }
          } else {
            notFound++;
            results.push({
              input: name,
              matched: null,
              note: "Not a recognized additive — may be a whole food ingredient",
            });
          }
        }

        const scoredResults = results.filter(
          (r) => r.safety_score !== undefined && r.safety_score !== null
        );
        const avgScore =
          scoredResults.length > 0
            ? scoredResults.reduce(
                (sum, r) => sum + (r.safety_score as number),
                0
              ) / scoredResults.length
            : 0;

        const overallAssessment = flagged.length === 0 && avgScore <= 3
              ? "LOW RISK"
              : flagged.length <= 2 && avgScore <= 5
                ? "MODERATE RISK"
                : "HIGH RISK";
        const summary: Record<string, unknown> = {
          total_ingredients: names.length,
          additives_found: found,
          not_recognized: notFound,
          flagged_count: flagged.length,
          allergen_count: allergens.length,
          average_safety_score: Math.round(avgScore * 10) / 10,
          overall_assessment: overallAssessment,
          flagged_additives: flagged,
          allergen_warnings: allergens,
          all_results: results,
          market_checked: market || "EU + US (default)",
          data_freshness: {
            database_version: "2026-05",
            source_type: "food_additive_safety_regulatory_reference_data",
          },
          source: "Roots by Benda — rootsbybenda.com",
          citation_ready: `Food label scan (${names.length} ingredients, ${market || "EU+US"}): ${overallAssessment}. ${found} additives matched, ${flagged.length} flagged${allergens.length > 0 ? `, ${allergens.length} allergen warnings` : ""}. Avg safety score ${Math.round(avgScore * 10) / 10}/10. Source: Roots by Benda (rootsbybenda.com).`,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ],
        };
      }
    );

    // Tool 3: search_additives — search by keyword, category, or concern
    this.server.tool(
      "search_additives",
      TOOL_CATALOG[2].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Food additive keyword, function, category, dietary status, or concern (e.g. 'preservative', 'sweetener', 'hyperactivity', 'banned', 'E1'). Use broad terms for discovery and exact additive names/E-numbers for narrower matching."
          ),
        filter: z
          .enum(FOOD_SEARCH_FILTERS)
          .optional()
          .describe(
            "Optional food-additive filter. Use 'high_risk' for elevated safety scores, 'allergens' for allergen-linked additives, 'banned' for restricted/banned signals, 'not_vegan' for animal-derived concerns, or 'not_halal' for halal compatibility concerns."
          ),
        limit: z
          .number()
          .finite()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .optional()
          .describe("Maximum number of additive records to return (1-25, default 10). Use higher limits for broad classes like preservatives and lower limits for exact additive names."),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query, filter, limit }) => {
        const maxResults = Math.min(Math.max(limit || 10, 1), MAX_SEARCH_RESULTS);
        const q = normalizeQuery(query);
        const pattern = likePattern(q);

        let whereClause = `(common_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR e_number LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR category LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR function_desc LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR health_concerns LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR hebrew_name LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
        const params: (string | number)[] = [
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
        ];

        if (filter === "high_risk") {
          whereClause += ` AND safety_score >= 7`;
        } else if (filter === "allergens") {
          whereClause += ` AND allergen_flag != 'no' AND allergen_flag != ''`;
        } else if (filter === "banned") {
          whereClause += ` AND banned_countries != '' AND banned_countries IS NOT NULL`;
        } else if (filter === "not_vegan") {
          whereClause += ` AND (vegan = 'no' OR vegan = 'No')`;
        } else if (filter === "not_halal") {
          whereClause += ` AND (halal = 'no' OR halal = 'No' OR halal = 'depends')`;
        }

        const results = await this.env.DB.prepare(
          `SELECT common_name, e_number, cas_number, category, function_desc,
                  safety_score, eu_status, us_status, health_concerns,
                  allergen_flag, vegan, halal, kosher, hebrew_name, adi_value, adi_unit
           FROM food_additives
           WHERE ${whereClause}
           ORDER BY safety_score DESC
           LIMIT ?`
        )
          .bind(...params, maxResults)
          .all();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  filter: filter || "none",
                  count: results.results?.length || 0,
                  results:
                    results.results?.map((r: Record<string, unknown>) => ({
                      name: r.common_name,
                      e_number: r.e_number || null,
                      cas: r.cas_number || null,
                      hebrew: r.hebrew_name || null,
                      category: r.category,
                      function: r.function_desc,
                      safety_score: r.safety_score,
                      eu_status: r.eu_status,
                      us_status: r.us_status,
                      concerns: r.health_concerns,
                      allergen: r.allergen_flag,
                      dietary: {
                        vegan: r.vegan,
                        halal: r.halal,
                        kosher: r.kosher,
                      },
                      adi: r.adi_value
                        ? `${r.adi_value} ${r.adi_unit}`
                        : null,
                    })) || [],
                  data_freshness: {
                    database_version: "2026-05",
                    source_type: "food_additive_safety_regulatory_reference_data",
                  },
                  citation_ready: `Food additive search "${query}"${filter ? ` (filter: ${filter})` : ""}: ${results.results?.length || 0} matches from 6,450+ additives. Source: Roots by Benda (rootsbybenda.com).`,
                  source: "Roots by Benda — rootsbybenda.com",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Tool 4: check_nutrition — look up nutritional profile of an Israeli food
    this.server.tool(
      "check_nutrition",
      TOOL_CATALOG[3].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Food name in Hebrew or English for Israeli Ministry of Health nutrition lookup (e.g. 'hummus', 'chicken breast', 'bread'). Use a specific food item rather than an additive, crop, or supplement."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query }) => {
        const q = normalizeQuery(query);

        // Try exact English match
        let food = await this.env.DB.prepare(
          `SELECT * FROM moh_nutrition WHERE english_name = ? COLLATE NOCASE`
        )
          .bind(q)
          .first();

        // Try exact Hebrew match
        if (!food) {
          food = await this.env.DB.prepare(
            `SELECT * FROM moh_nutrition WHERE hebrew_name = ? COLLATE NOCASE`
          )
            .bind(q)
            .first();
        }

        // Try fuzzy English
        if (!food) {
          food = await this.env.DB.prepare(
            `SELECT * FROM moh_nutrition WHERE english_name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(likePattern(q))
            .first();
        }

        // Try fuzzy Hebrew
        if (!food) {
          food = await this.env.DB.prepare(
            `SELECT * FROM moh_nutrition WHERE hebrew_name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(likePattern(q))
            .first();
        }

        if (!food) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "not_found",
                  message: `No food found matching "${query}". Try searching in Hebrew or English (e.g. 'rice', 'אורז').`,
                }),
              },
            ],
          };
        }

        const result = {
          hebrew_name: food.hebrew_name,
          english_name: food.english_name,
          per_100g: {
            energy_kcal: food.food_energy,
            protein_g: food.protein,
            total_fat_g: food.total_fat,
            carbohydrates_g: food.carbohydrates,
            dietary_fiber_g: food.total_dietary_fiber,
            total_sugars_g: food.total_sugars,
            alcohol_g: food.alcohol,
            moisture_g: food.moisture,
          },
          vitamins: {
            vitamin_a_iu: food.vitamin_a_iu,
            vitamin_c_mg: food.vitamin_c,
            vitamin_e_mg: food.vitamin_e,
            vitamin_d_mcg: food.vitamin_d,
            vitamin_k_mcg: food.vitamin_k,
            vitamin_b6_mg: food.vitamin_b6,
            vitamin_b12_mcg: food.vitamin_b12,
            thiamin_b1_mg: food.thiamin,
            riboflavin_b2_mg: food.riboflavin,
            niacin_b3_mg: food.niacin,
            folate_mcg: food.folate,
          },
          minerals: {
            calcium_mg: food.calcium,
            iron_mg: food.iron,
            magnesium_mg: food.magnesium,
            phosphorus_mg: food.phosphorus,
            potassium_mg: food.potassium,
            sodium_mg: food.sodium,
            zinc_mg: food.zinc,
            selenium_mcg: food.selenium,
            choline_mg: food.choline,
          },
          fats: {
            cholesterol_mg: food.cholesterol,
            saturated_fat_g: food.saturated_fat,
            monounsaturated_fat_g: food.mono_unsaturated_fat,
            polyunsaturated_fat_g: food.poly_unsaturated_fat,
            trans_fat_g: food.trans_fatty_acids,
          },
          source: "Israel MOH Nutrition Database — Roots by Benda (rootsbybenda.com)",
          citation_ready: `${food.english_name || food.hebrew_name} (per 100g): ${food.food_energy || "N/A"} kcal, ${food.protein || "N/A"}g protein, ${food.total_fat || "N/A"}g fat, ${food.carbohydrates || "N/A"}g carbs. Source: Israel Ministry of Health Nutrition Database via Roots by Benda (rootsbybenda.com).`,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }
    );

    // Tool 5: check_pesticide_mrl — check maximum residue limits for pesticides on crops in Israel
    this.server.tool(
      "check_pesticide_mrl",
      TOOL_CATALOG[4].description,
      {
        query: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUERY_INPUT_LENGTH)
          .describe(
            "Pesticide active substance, crop name, or pesticide-plus-crop phrase for Israeli MRL lookup (e.g. 'glyphosate', 'tomato', 'chlorpyrifos apple'). Use crop/pesticide pairs when the requested residue limit depends on the food commodity."
          ),
      },
      READ_ONLY_TOOL_ANNOTATIONS,
      async ({ query }) => {
        const q = normalizeQuery(query);
        const parts = q.split(/\s+/);

        let results;

        if (parts.length >= 2) {
          // Try to match both pesticide and crop
          const p0Pattern = likePattern(parts[0]);
          const pRestPattern = likePattern(parts.slice(1).join(" "));
          results = await this.env.DB.prepare(
            `SELECT * FROM il_pesticide_mrl
             WHERE (active_substance LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_english LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_hebrew LIKE ? ESCAPE '\\' COLLATE NOCASE)
               AND (active_substance LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_english LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_hebrew LIKE ? ESCAPE '\\' COLLATE NOCASE)
             LIMIT ?`
          )
            .bind(
              p0Pattern, p0Pattern, p0Pattern,
              pRestPattern, pRestPattern, pRestPattern,
              MAX_MRL_RESULTS
            )
            .all();
        }

        if (!results || !results.results?.length) {
          const pattern = likePattern(q);
          results = await this.env.DB.prepare(
            `SELECT * FROM il_pesticide_mrl
             WHERE active_substance LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR crop_english LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR crop_hebrew LIKE ? ESCAPE '\\' COLLATE NOCASE
             ORDER BY active_substance, crop_english
             LIMIT ?`
          )
            .bind(pattern, pattern, pattern, MAX_MRL_RESULTS)
            .all();
        }

        if (!results.results?.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "not_found",
                  message: `No MRL records found for "${query}". Try searching by pesticide name (e.g. 'glyphosate') or crop (e.g. 'tomato', 'עגבניה').`,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  count: results.results.length,
                  results: results.results.map((r: Record<string, unknown>) => ({
                    pesticide: r.active_substance,
                    crop_hebrew: r.crop_hebrew,
                    crop_english: r.crop_english,
                    mrl_mg_per_kg: r.mrl_value,
                    last_updated: r.update_date,
                    pending_change: r.mrl_pending || null,
                    source: "Israel MOH Pesticide Residue Limits",
                  })),
                  note: "MRL = Maximum Residue Limit in mg/kg (ppm). Values set by Israel MOH.",
                  citation_ready: `Pesticide MRL search "${query}": ${results.results.length} records. Source: Israel Ministry of Health Pesticide Residue Limits via Roots by Benda (rootsbybenda.com).`,
                  source: "Israel MOH Pesticide Residues — Roots by Benda (rootsbybenda.com)",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}

// Worker entry point
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Resolve auth early — use user_id for rate limiting when authenticated (better for shared IPs)
    let auth: AuthProps | null = null;
    const isDataEndpoint = url.pathname === "/mcp" || url.pathname === "/sse" || url.pathname.startsWith("/sse/") || (request.method === "POST" && url.pathname === "/");
    if (isDataEndpoint) {
      auth = await resolveAuth(request, env);
      const rateLimitKey = auth.user_id || request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
      if (!checkRateLimit(rateLimitKey)) {
        return rateLimitResponse();
      }
    }

    // SEP-1649: route MCP clients that POST initialize to root to streamable HTTP.
    if (request.method === "POST" && url.pathname === "/") {
      if (!auth) auth = await resolveAuth(request, env);
      (ctx as ExecutionContext & { props?: AuthProps }).props = auth;
      const mcpUrl = new URL(request.url);
      mcpUrl.pathname = "/mcp";
      const mcpRequest = new Request(mcpUrl.toString(), request);
      return FoodMCP.serve("/mcp").fetch(mcpRequest, env, ctx);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        status: "healthy",
        description: SERVER_DESCRIPTION,
        tools: TOOL_CATALOG.map((tool) => tool.name),
        data: DATA_CATALOG,
        docs: HOMEPAGE,
        homepage: HOMEPAGE,
        source: SOURCE,
      });
    }


    if (url.pathname === "/.well-known/mcp/server.json") {
      return Response.json(registryMetadata(), {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }

    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return Response.json({
        "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
        "version": "1.0",
        "protocolVersion": "2025-06-18",
        "serverInfo": { "name": "food-mcp-server", "title": SERVER_NAME, "version": SERVER_VERSION },
        "description": SERVER_DESCRIPTION,
        "iconUrl": "https://rootsbybenda.com/icon.png",
        "documentationUrl": "https://rootsbybenda.com",
        "transport": { "type": "streamable-http", "endpoint": "/mcp" },
        "capabilities": { "tools": { "listChanged": true }, "resources": { "subscribe": false, "listChanged": false } },
        "authentication": { "required": false, "schemes": ["bearer"], "note": "Optional API key enables per-user rate limiting" },
        "rateLimit": { "requestsPerMinute": 60, "enforcement": "per-ip-or-user" },
        "tools": TOOL_CATALOG
      }, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    }

    // Resolve auth and set on ctx.props for MCP transport endpoints
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/") || url.pathname === "/mcp") {
      if (!auth) auth = await resolveAuth(request, env);
      (ctx as ExecutionContext & { props?: AuthProps }).props = auth;
    }

    // SSE transport (legacy clients)
    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return FoodMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    // Streamable HTTP transport (new spec)
    if (url.pathname === "/mcp") {
      return FoodMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
