import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

const SERVER_VERSION = "1.0.0";
const HOMEPAGE = "https://rootsbybenda.com";
const SOURCE = "Roots by Benda \u2014 rootsbybenda.com";
const CONTACT = "SBD@effortlessai.ai";
const SERVER_NAME = "Roots by Benda \u2014 Food Intelligence";
const SERVER_DESCRIPTION =
  "Roots by Benda answers whether E171 or another food additive is safe by checking 6,450+ food additives, 6,563+ JECFA evaluations, 5,251+ EFSA substances, 77,278+ synonyms, Israeli nutrition profiles, and pesticide MRLs. It is a free, source-linked food safety MCP for additives, E-numbers, ADI, halal/kosher/vegan compatibility, nutrition, and pesticide residue review; ask your AI: 'check if E171 is safe as a food additive'.";
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
    description: "Look up a food additive by name, E-number, or CAS number. Returns safety score, ADI, JECFA/EFSA evidence, EU/US/Israel status, health concerns, allergens, and vegan/halal/kosher compatibility."
  },
  {
    name: "check_ingredient_list",
    description: "Scan a packaged-food ingredient list for additive safety and regulatory flags. Returns matched additives, high-risk scores, banned-country notes, allergen warnings, dietary compatibility issues, and an overall food safety assessment."
  },
  {
    name: "search_additives",
    description: "Search food additives by keyword, category, function, dietary status, or health concern. Use for finding preservatives, colorants, sweeteners, allergens, banned additives, or high-risk E-numbers before a deeper additive check."
  },
  {
    name: "check_nutrition",
    description: "Look up Israeli Ministry of Health nutrition data for a food item in Hebrew or English. Returns per-100g calories, macronutrients, vitamins, minerals, fatty acids, cholesterol, sugars, and fiber."
  },
  {
    name: "check_pesticide_mrl",
    description: "Check Israeli pesticide maximum residue limits (MRLs) by pesticide, crop, or combined query. Returns active substance, crop, official MRL value in mg/kg, update date, and pending-change notes."
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
            "Food additive name, E-number, or CAS number (e.g. 'aspartame', 'E951', '22839-47-0')"
          ),
      },
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

        const result = {
          name: additive.common_name,
          e_number: additive.e_number || null,
          chemical_name: additive.chemical_name || null,
          cas_number: additive.cas_number || null,
          hebrew_name: additive.hebrew_name || null,
          category: additive.category,
          function: additive.function_desc,
          source_type: additive.source_type,
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
            source: additive.adi_source,
          },
          regulatory: {
            eu_status: additive.eu_status,
            us_status: additive.us_status,
            max_permitted_level_ppm: additive.max_permitted_level_ppm || null,
            banned_countries: additive.banned_countries || null,
            israel: ilStatus
              ? {
                  status: ilStatus.status,
                  type: ilStatus.additive_type,
                  notes: ilStatus.notes,
                }
              : null,
          },
          health: {
            concerns: additive.health_concerns,
            allergen: additive.allergen_flag,
            iarc_group: additive.iarc_group || null,
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
            })) || [],
          efsa_data:
            efsa.results?.map((e: Record<string, unknown>) => ({
              adi: e.adi_value ? `${e.adi_value} ${e.adi_unit}` : null,
              tdi: e.tdi_value ? `${e.tdi_value} ${e.tdi_unit}` : null,
              noael: e.noael_value
                ? `${e.noael_value} ${e.noael_unit}`
                : null,
              genotoxicity: e.genotoxicity,
            })) || [],
          source: "Roots by Benda — rootsbybenda.com",
          data_verified: "2026-03",
        };

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
            "Comma-separated or newline-separated list of food ingredients (e.g. 'Water, Sugar, Citric Acid, Sodium Benzoate, Aspartame')"
          ),
        market: z
          .enum(FOOD_MARKETS)
          .optional()
          .describe(
            "Target market for compliance check (e.g. 'EU', 'US', 'Israel'). Defaults to EU + US."
          ),
      },
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

        const summary = {
          total_ingredients: names.length,
          additives_found: found,
          not_recognized: notFound,
          flagged_count: flagged.length,
          allergen_count: allergens.length,
          average_safety_score: Math.round(avgScore * 10) / 10,
          overall_assessment:
            flagged.length === 0 && avgScore <= 3
              ? "LOW RISK"
              : flagged.length <= 2 && avgScore <= 5
                ? "MODERATE RISK"
                : "HIGH RISK",
          flagged_additives: flagged,
          allergen_warnings: allergens,
          all_results: results,
          market_checked: market || "EU + US (default)",
          source: "Roots by Benda — rootsbybenda.com",
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
            "Search keyword (e.g. 'preservative', 'sweetener', 'hyperactivity', 'banned', 'E1')"
          ),
        filter: z
          .enum(FOOD_SEARCH_FILTERS)
          .optional()
          .describe(
            "Optional filter: 'high_risk' (score >= 7), 'allergens', 'banned', 'not_vegan', 'not_halal'. Leave empty for all matches."
          ),
        limit: z
          .number()
          .finite()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .optional()
          .describe("Max results to return (1-25, default 10)"),
      },
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
            "Food name in Hebrew or English (e.g. 'חומוס', 'hummus', 'chicken breast', 'לחם')"
          ),
      },
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
            "Pesticide name, crop name, or both (e.g. 'glyphosate', 'tomato', 'chlorpyrifos apple')"
          ),
      },
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
                  })),
                  note: "MRL = Maximum Residue Limit in mg/kg (ppm). Values set by Israel MOH.",
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
