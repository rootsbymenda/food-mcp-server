import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Escape LIKE special characters in user input to prevent wildcard injection
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
}

export class FoodMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "twohalves-food-safety",
    version: "1.0.0",
  });

  async init() {
    // Tool 1: check_additive — lookup by name, E-number, or CAS number
    this.server.tool(
      "check_additive",
      "Look up a food additive by name, E-number, or CAS number. Returns safety score, ADI (Acceptable Daily Intake), health concerns, EU/US regulatory status, dietary compatibility (vegan, halal, kosher), allergen flags, and Israeli regulatory status.",
      {
        query: z
          .string()
          .describe(
            "Food additive name, E-number, or CAS number (e.g. 'aspartame', 'E951', '22839-47-0')"
          ),
      },
      async ({ query }) => {
        const q = query.trim();

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
          const qEsc = escapeLike(q);
          additive = await this.env.DB.prepare(
            `SELECT * FROM food_additives WHERE common_name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(`%${qEsc}%`)
            .first();
        }

        // Try synonyms table
        if (!additive) {
          const qEsc = escapeLike(q);
          const synonym = await this.env.DB.prepare(
            `SELECT additive_id FROM food_synonyms WHERE synonym LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(`%${qEsc}%`)
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
        const jecfa = await this.env.DB.prepare(
          `SELECT adi_raw, adi_upper, adi_status, functional_class, evaluation_year
           FROM jecfa_adi
           WHERE chemical_name LIKE ? COLLATE NOCASE
              OR cas_number = ?
           LIMIT 3`
        )
          .bind(
            `%${additive.common_name}%`,
            (additive.cas_number as string) || ""
          )
          .all();

        // Get EFSA toxicology data if available
        const efsa = await this.env.DB.prepare(
          `SELECT substance_name, adi_value, adi_unit, tdi_value, tdi_unit,
                  noael_value, noael_unit, genotoxicity
           FROM food_substances
           WHERE substance_name LIKE ? COLLATE NOCASE
              OR cas_number = ?
           LIMIT 3`
        )
          .bind(
            `%${additive.common_name}%`,
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
          source: "Two Halves — twohalves.ai",
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
      "Check a list of food ingredients for safety and regulatory compliance. Pass a product's ingredient list and get flagged additives, banned substances, allergen warnings, and an overall safety assessment.",
      {
        ingredients: z
          .string()
          .describe(
            "Comma-separated or newline-separated list of food ingredients (e.g. 'Water, Sugar, Citric Acid, Sodium Benzoate, Aspartame')"
          ),
        market: z
          .string()
          .optional()
          .describe(
            "Target market for compliance check (e.g. 'EU', 'US', 'Israel'). Defaults to EU + US."
          ),
      },
      async ({ ingredients, market }) => {
        const names = ingredients
          .split(/[,\n]+/)
          .map((n) => n.trim())
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

        if (names.length > 60) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "too_many",
                  message:
                    "Maximum 60 ingredients per request. Split into multiple calls.",
                }),
              },
            ],
          };
        }

        const results = [];
        const flagged = [];
        const allergens = [];
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
            const nameEsc = escapeLike(name);
            additive = await this.env.DB.prepare(
              `SELECT id, common_name, e_number, cas_number, safety_score, eu_status, us_status,
                      health_concerns, allergen_flag, category, adi_value, adi_unit,
                      banned_countries, hyperactivity_link, children_safe, pregnancy_safe
               FROM food_additives
               WHERE common_name LIKE ? ESCAPE '\\' COLLATE NOCASE
               LIMIT 1`
            )
              .bind(`%${nameEsc}%`)
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
          source: "Two Halves — twohalves.ai",
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
      "Search the food additive database by keyword, category, function, or health concern. Useful for finding all preservatives, colorants linked to hyperactivity, banned additives, etc.",
      {
        query: z
          .string()
          .describe(
            "Search keyword (e.g. 'preservative', 'sweetener', 'hyperactivity', 'banned', 'E1')"
          ),
        filter: z
          .string()
          .optional()
          .describe(
            "Optional filter: 'high_risk' (score >= 7), 'allergens', 'banned', 'not_vegan', 'not_halal'. Leave empty for all matches."
          ),
        limit: z
          .number()
          .optional()
          .describe("Max results to return (1-25, default 10)"),
      },
      async ({ query, filter, limit }) => {
        const maxResults = Math.min(Math.max(limit || 10, 1), 25);
        const queryEsc = escapeLike(query);

        let whereClause = `(common_name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR e_number LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR category LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR function_desc LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR health_concerns LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR hebrew_name LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
        const params: (string | number)[] = [
          `%${queryEsc}%`,
          `%${queryEsc}%`,
          `%${queryEsc}%`,
          `%${queryEsc}%`,
          `%${queryEsc}%`,
          `%${queryEsc}%`,
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
                  source: "Two Halves — twohalves.ai",
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
      "Look up the full nutritional profile of a food item from the Israeli MOH nutrition database. Returns calories, macros (protein, fat, carbs), vitamins, minerals, amino acids, and fatty acid breakdown. Search by Hebrew or English name.",
      {
        query: z
          .string()
          .describe(
            "Food name in Hebrew or English (e.g. 'חומוס', 'hummus', 'chicken breast', 'לחם')"
          ),
      },
      async ({ query }) => {
        const q = query.trim();

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
          const qEsc = escapeLike(q);
          food = await this.env.DB.prepare(
            `SELECT * FROM moh_nutrition WHERE english_name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(`%${qEsc}%`)
            .first();
        }

        // Try fuzzy Hebrew
        if (!food) {
          const qEsc = escapeLike(q);
          food = await this.env.DB.prepare(
            `SELECT * FROM moh_nutrition WHERE hebrew_name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1`
          )
            .bind(`%${qEsc}%`)
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
          source: "Israel MOH Nutrition Database — Two Halves (twohalves.ai)",
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
      "Check the Israeli Maximum Residue Limit (MRL) for a pesticide on a specific crop. Returns the official MRL value in mg/kg (ppm) set by the Israel MOH. Search by pesticide name, crop name, or both.",
      {
        query: z
          .string()
          .describe(
            "Pesticide name, crop name, or both (e.g. 'glyphosate', 'tomato', 'chlorpyrifos apple')"
          ),
      },
      async ({ query }) => {
        const q = query.trim();
        const parts = q.split(/\s+/);

        let results;

        if (parts.length >= 2) {
          // Try to match both pesticide and crop
          const p0Esc = escapeLike(parts[0]);
          const pRestEsc = escapeLike(parts.slice(1).join(' '));
          results = await this.env.DB.prepare(
            `SELECT * FROM il_pesticide_mrl
             WHERE (active_substance LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_english LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_hebrew LIKE ? ESCAPE '\\' COLLATE NOCASE)
               AND (active_substance LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_english LIKE ? ESCAPE '\\' COLLATE NOCASE OR crop_hebrew LIKE ? ESCAPE '\\' COLLATE NOCASE)
             LIMIT 20`
          )
            .bind(
              `%${p0Esc}%`, `%${p0Esc}%`, `%${p0Esc}%`,
              `%${pRestEsc}%`, `%${pRestEsc}%`, `%${pRestEsc}%`
            )
            .all();
        }

        if (!results || !results.results?.length) {
          const qEsc = escapeLike(q);
          results = await this.env.DB.prepare(
            `SELECT * FROM il_pesticide_mrl
             WHERE active_substance LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR crop_english LIKE ? ESCAPE '\\' COLLATE NOCASE
                OR crop_hebrew LIKE ? ESCAPE '\\' COLLATE NOCASE
             ORDER BY active_substance, crop_english
             LIMIT 20`
          )
            .bind(`%${qEsc}%`, `%${qEsc}%`, `%${qEsc}%`)
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
                  source: "Israel MOH Pesticide Residues — Two Halves (twohalves.ai)",
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

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "Two Halves Food Safety MCP Server",
          version: "1.1.0",
          status: "healthy",
          tools: [
            "check_additive",
            "check_ingredient_list",
            "search_additives",
            "check_nutrition",
            "check_pesticide_mrl",
          ],
          data: {
            food_additives: "6,450+",
            jecfa_evaluations: "6,563+",
            efsa_substances: "5,251+",
            food_synonyms: "77,278+",
            israeli_permitted: "319",
            nutrition_profiles: "4,624",
            pesticide_mrls: "3,708",
          },
          docs: "https://twohalves.ai",
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
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
