# Roots by Benda — Food Safety & Regulatory Intelligence MCP Server

[![smithery badge](https://smithery.ai/badge/twohalves/food-safety)](https://smithery.ai/servers/twohalves/food-safety)

**Food additive safety, nutrition, and pesticide residue data in one MCP.** Check any E-number, food additive, or ingredient against JECFA/EFSA evaluations, ADI limits, allergen flags, dietary compatibility (halal/kosher/vegan), Israeli nutrition profiles, and pesticide MRLs — all source-linked and free.

Equivalent data through commercial food safety platforms (FoodNavigator Pro, Decernis) costs $15,000+/year. This MCP is free.

**Live endpoint:** `https://food-mcp-server.rootsbybenda.workers.dev/mcp`
**SSE fallback:** `https://food-mcp-server.rootsbybenda.workers.dev/sse`

## Tools

### `check_additive`
Look up a food additive by name, E-number, or CAS number. Returns safety score, ADI (Acceptable Daily Intake), JECFA/EFSA evidence, EU/US/Israel regulatory status, health concerns, allergens, and vegan/halal/kosher compatibility.

```
query: "E171"
→ Titanium Dioxide; Safety: 3/10 (high concern); ADI: not established (EFSA 2021 withdrawal);
  EU: banned as food additive (2022); US: permitted ≤1%; Concerns: genotoxicity (nano)
```

### `check_ingredient_list`
Scan a packaged-food ingredient list for additive safety and regulatory flags. Returns matched additives, high-risk scores, banned-country notes, allergen warnings, dietary compatibility issues, and an overall food safety assessment.

```
ingredients: "Sugar, E150d, E621, Citric Acid, E211"
→ Risk: MODERATE — E211 (sodium benzoate) flagged for benzene formation with ascorbic acid;
  E621 (MSG) sensitivity concern; E150d (caramel IV) has 4-MEI limit
```

### `search_additives`
Search food additives by keyword, category, function, dietary status, or health concern. Use for finding preservatives, colorants, sweeteners, allergens, banned additives, or high-risk E-numbers.

```
query: "banned preservative" → matches BHA (E320), potassium bromate, etc.
```

### `check_nutrition`
Look up Israeli Ministry of Health nutrition data for a food item in Hebrew or English. Returns per-100g calories, macronutrients, vitamins, minerals, fatty acids, cholesterol, sugars, and fiber.

```
query: "חומוס" → Calories: 166kcal, Protein: 8.0g, Fat: 9.6g, Carbs: 14.3g, Fiber: 6.0g
```

### `check_pesticide_mrl`
Check Israeli pesticide maximum residue limits (MRLs) by pesticide, crop, or combined query. Returns active substance, crop, official MRL value in mg/kg, update date, and pending-change notes.

```
query: "glyphosate wheat" → MRL: 10.0 mg/kg; Status: active; Updated: 2023
```

## Data

| Dataset | Records |
|---------|---------|
| Food additives (curated) | 6,450+ |
| JECFA evaluations | 6,563+ |
| EFSA substance records | 5,251+ |
| Additive synonyms | 77,278+ |
| Israeli nutrition profiles (MoH) | 4,624 |
| Pesticide MRLs (Israel) | 3,708 |

**100% source-traceability:** every record links to JECFA, EFSA, Codex Alimentarius, or national authority primary sources.

**Sources:** JECFA (WHO/FAO Joint Expert Committee on Food Additives), EFSA (European Food Safety Authority), Codex Alimentarius, Israeli Ministry of Health, EU Regulation 1333/2008, FDA GRAS, Israel Plant Protection Service.

## Quick Start

### Claude Desktop / Claude Code
Add to your MCP config:
```json
{
  "mcpServers": {
    "roots-food-safety": {
      "url": "https://food-mcp-server.rootsbybenda.workers.dev/sse"
    }
  }
}
```

### Cursor / Windsurf / Zed
Use the Streamable HTTP endpoint:
```
https://food-mcp-server.rootsbybenda.workers.dev/mcp
```

## Rate Limits

Every caller receives full data; a 60 requests/minute abuse-prevention limit applies per IP.

## Built With

- [Cloudflare Workers](https://workers.cloudflare.com/) + [Agents SDK](https://developers.cloudflare.com/agents/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) (session-scoped rate limiting)
- [Model Context Protocol](https://modelcontextprotocol.io/) (MCP)

## Who Built This

**Roots by Benda** — regulatory intelligence platform built by Shahar Ben-David with Claude. Food safety database assembled from primary sources across JECFA, EFSA, Codex Alimentarius, Israeli MoH, and FDA.

- Website: [rootsbybenda.com](https://rootsbybenda.com)
- LinkedIn: [Shahar Ben-David](https://www.linkedin.com/in/shahar-ben-david-25549a3a8/)

## License

MIT
