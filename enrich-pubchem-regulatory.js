/**
 * PubChem Regulatory Annotations Enrichment
 * For each CID we already have, fetch JECFA ADI + EU + FDA annotations via PUG-View
 * Rate limit: 4 req/sec
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Load our enrichment data (has CIDs)
const enriched = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'pubchem-enrichment.json'), 'utf8'));
console.log(`Loaded ${enriched.length} CIDs to fetch regulatory data for`);

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
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

function extractAnnotations(pugViewData) {
  const result = { jecfa_adi: null, eu_info: null, fda_status: null };
  if (!pugViewData?.Annotations?.Annotation) return result;

  for (const ann of pugViewData.Annotations.Annotation) {
    const src = ann.SourceName || '';
    const val = ann.Data?.[0]?.Value?.StringWithMarkup?.[0]?.String
             || ann.Description
             || ann.AnnotationValue
             || '';

    if (src.includes('JECFA') && val) {
      result.jecfa_adi = val.substring(0, 500);
    }
    if ((src.includes('EU Food') || src.includes('European')) && val) {
      result.eu_info = val.substring(0, 500);
    }
    if (src.includes('FDA') && val) {
      result.fda_status = val.substring(0, 500);
    }
  }
  return result;
}

async function main() {
  const results = [];
  let processed = 0, found = 0;

  for (const item of enriched) {
    processed++;
    const cid = item.cid;

    // Fetch all annotations for this CID
    const annRes = await fetchJSON(`https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON?heading=Food+Additives+and+Ingredients`);
    await sleep(260);

    const annotations = extractAnnotations(annRes);

    // If nothing from Food Additives heading, try broader search
    if (!annotations.jecfa_adi && !annotations.eu_info && !annotations.fda_status) {
      const annRes2 = await fetchJSON(`https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON?heading=Food+Additive+Classes`);
      await sleep(260);
      const ann2 = extractAnnotations(annRes2);
      if (ann2.jecfa_adi) annotations.jecfa_adi = ann2.jecfa_adi;
      if (ann2.eu_info) annotations.eu_info = ann2.eu_info;
      if (ann2.fda_status) annotations.fda_status = ann2.fda_status;
    }

    if (annotations.jecfa_adi || annotations.eu_info || annotations.fda_status) {
      found++;
      results.push({
        id: item.id,
        cid,
        name: item.name,
        ...annotations
      });
    }

    if (processed % 100 === 0) {
      console.log(`${processed}/${enriched.length} | found annotations: ${found}`);
      fs.writeFileSync(path.join(os.homedir(), 'pubchem-regulatory.json'), JSON.stringify(results, null, 2));
    }
  }

  fs.writeFileSync(path.join(os.homedir(), 'pubchem-regulatory.json'), JSON.stringify(results, null, 2));
  console.log(`\nComplete! ${found} substances with regulatory annotations out of ${enriched.length}.`);
}

main().catch(console.error);
