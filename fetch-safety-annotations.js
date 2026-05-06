/**
 * PubChem Safety Annotations Fetcher
 * Pulls Carcinogen, Endocrine Disruptor, and ICSC annotations
 * Based on Perplexity Deep Research verified endpoints
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTDIR = path.join(os.homedir(), 'pubchem_annotations');
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

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
  console.log(`\n=== ${label} ===`);
  const allAnnotations = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const sep = urlBase.includes('?') ? '&' : '?';
    const url = `${urlBase}${sep}page=${page}`;
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
  console.log(`  SAVED: ${allAnnotations.length} → ${outPath}`);
  return allAnnotations.length;
}

async function main() {
  const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/annotations/heading';

  // Carcinogen Classification (~5,163 records, 6 pages)
  const c1 = await fetchPaginated(
    'Carcinogen Classification',
    `${BASE}/Carcinogen%20Classification/JSON?heading_type=Compound`,
    'carcinogen_classification.json'
  );

  // Evidence for Carcinogenicity (~1,448 records, 2 pages)
  const c2 = await fetchPaginated(
    'Evidence for Carcinogenicity',
    `${BASE}/Evidence%20for%20Carcinogenicity/JSON?heading_type=Compound`,
    'evidence_carcinogenicity.json'
  );

  // Endocrine Disruptors (~6,132 records, 7 pages)
  const ed = await fetchPaginated(
    'Endocrine Disruptors',
    `${BASE}/Endocrine%20Disruptors/JSON?heading_type=Compound`,
    'endocrine_disruptors.json'
  );

  // ICSC Number (~1,712 records, 2 pages)
  const ic = await fetchPaginated(
    'ICSC Number (Chemical Safety Cards)',
    `${BASE}/ICSC%20Number/JSON?heading_type=Compound`,
    'icsc_number.json'
  );

  // Skin, Eye, Respiratory Irritation (~2,195 records, 3 pages)
  const ir = await fetchPaginated(
    'Skin Eye Respiratory Irritation',
    `${BASE}/Skin%2C%20Eye%2C%20and%20Respiratory%20Irritations/JSON?heading_type=Compound`,
    'irritation.json'
  );

  console.log(`\n=== COMPLETE ===`);
  console.log(`Carcinogen Classification: ${c1}`);
  console.log(`Evidence Carcinogenicity: ${c2}`);
  console.log(`Endocrine Disruptors: ${ed}`);
  console.log(`ICSC Safety Cards: ${ic}`);
  console.log(`Irritation: ${ir}`);
  console.log(`Total: ${c1 + c2 + ed + ic + ir}`);
}

main().catch(console.error);
