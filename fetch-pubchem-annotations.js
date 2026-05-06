/**
 * PubChem Bulk Annotation Fetcher
 * Based on Perplexity Deep Research findings
 * Sources: JECFA (14181), EU Food Improvement Agents (15617), FDA SAF (18821)
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTDIR = path.join(os.homedir(), 'pubchem_annotations');
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR);

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPaginated(label, urlBase, outFile) {
  console.log(`\n=== Fetching ${label} ===`);
  const allAnnotations = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${urlBase}&page=${page}`;
    console.log(`  Page ${page}/${totalPages}...`);
    const data = await fetchJSON(url);
    await sleep(300);

    if (!data || !data.Annotations) {
      console.log(`  No data on page ${page}`);
      break;
    }

    if (page === 1) {
      totalPages = data.Annotations.TotalPages || 1;
      console.log(`  TotalPages: ${totalPages}`);
    }

    const annotations = data.Annotations.Annotation || [];
    console.log(`  Got ${annotations.length} annotations`);
    allAnnotations.push(...annotations);
    page++;
  }

  const outPath = path.join(OUTDIR, outFile);
  fs.writeFileSync(outPath, JSON.stringify(allAnnotations, null, 2));
  console.log(`  SAVED: ${allAnnotations.length} annotations → ${outPath}`);
  return allAnnotations.length;
}

async function main() {
  const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/annotations/heading';

  // 1. JECFA Number
  const j1 = await fetchPaginated(
    'JECFA - JECFA Number',
    `${BASE}/JECFA%20Number/JSON?heading_type=Compound`,
    'jecfa_number.json'
  );

  // 2. JECFA Evaluations (non-flavorings)
  const j2 = await fetchPaginated(
    'JECFA - Evaluations',
    `${BASE}/JSON?heading=Evaluations+of+the+Joint+FAO%2FWHO+Expert+Committee+on+Food+Additives+-+JECFA&heading_type=Compound`,
    'jecfa_evaluations.json'
  );

  // 3. EU Food Improvement Agents
  const eu = await fetchPaginated(
    'EU Food Improvement Agents',
    `${BASE}/Use%20Classification/JSON?source=EU+Food+Improvement+Agents&heading_type=Compound`,
    'eu_food_improvement.json'
  );

  // 4. FDA Substances Added to Food
  const fda = await fetchPaginated(
    'FDA Substances Added to Food',
    `${BASE}/FDA+Substances+Added+to+Food/JSON?heading_type=Compound`,
    'fda_saf.json'
  );

  console.log(`\n=== COMPLETE ===`);
  console.log(`JECFA Number: ${j1}`);
  console.log(`JECFA Evaluations: ${j2}`);
  console.log(`EU Food Improvement: ${eu}`);
  console.log(`FDA SAF: ${fda}`);
  console.log(`Total: ${j1 + j2 + eu + fda}`);
  console.log(`Files saved to: ${OUTDIR}`);
}

main().catch(console.error);
