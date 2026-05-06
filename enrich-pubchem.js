/**
 * PubChem Enrichment Pipeline v2
 * Reads CAS numbers from local cas-list.json, queries PubChem for CID + properties.
 * Rate limit: 4 req/sec (250ms between requests)
 * Saves results to pubchem-enrichment.json for later D1 import.
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const additives = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'cas-list.json'), 'utf8'));
console.log(`Loaded ${additives.length} additives with CAS numbers`);

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
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

async function main() {
  const enriched = [];
  let processed = 0, found = 0, notFound = 0;
  const outputFile = path.join(os.homedir(), 'pubchem-enrichment.json');

  for (const a of additives) {
    processed++;

    // CAS -> CID
    const cidRes = await fetchJSON(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(a.cas_number)}/cids/JSON`);
    await sleep(260);

    const cid = cidRes?.IdentifierList?.CID?.[0];
    if (!cid) { notFound++; if (processed % 100 === 0) console.log(`${processed}/${additives.length} | found: ${found} | miss: ${notFound}`); continue; }

    // CID -> properties
    const propsRes = await fetchJSON(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,IUPACName,InChIKey,XLogP/JSON`);
    await sleep(260);

    const p = propsRes?.PropertyTable?.Properties?.[0] || {};

    enriched.push({
      id: a.id,
      cas: a.cas_number,
      name: a.common_name,
      e_number: a.e_number,
      cid,
      formula: p.MolecularFormula || null,
      weight: p.MolecularWeight || null,
      iupac: p.IUPACName || null,
      inchikey: p.InChIKey || null,
      xlogp: p.XLogP || null,
    });
    found++;

    if (processed % 100 === 0) {
      console.log(`${processed}/${additives.length} | found: ${found} | miss: ${notFound}`);
      fs.writeFileSync(outputFile, JSON.stringify(enriched, null, 2));
    }
  }

  fs.writeFileSync(outputFile, JSON.stringify(enriched, null, 2));
  console.log(`\nComplete! ${found} enriched, ${notFound} not found out of ${additives.length} total.`);
  console.log(`Saved to ${outputFile}`);
}

main().catch(console.error);
