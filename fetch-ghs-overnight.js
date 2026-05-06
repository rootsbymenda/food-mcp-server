/**
 * PubChem GHS Classification Bulk Download — OVERNIGHT RUN
 * 358,165 records across 359 pages
 * FIXED: writes per-page JSONL files instead of one giant JSON
 * Resumes from last saved page automatically
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTDIR = path.join(os.homedir(), 'pubchem_annotations', 'ghs_pages');
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const PROGRESS_FILE = path.join(os.homedir(), 'pubchem_annotations', 'ghs_progress.json');

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
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
  const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/annotations/heading';

  // Resume from progress
  let startPage = 1;
  let totalSaved = 0;

  if (fs.existsSync(PROGRESS_FILE)) {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    startPage = progress.lastPage + 1;
    totalSaved = progress.totalSaved || 0;
    console.log(`Resuming from page ${startPage} (${totalSaved} annotations saved so far)`);
  }

  let totalPages = 359;
  let page = startPage;
  let retries = 0;

  console.log(`\n=== GHS Classification Bulk Download ===`);
  console.log(`Target: ~358,165 records across ${totalPages} pages`);
  console.log(`Starting at page ${page}\n`);

  while (page <= totalPages) {
    const url = `${BASE}/GHS%20Classification/JSON?heading_type=Compound&page=${page}`;

    const data = await fetchJSON(url);
    await sleep(350);

    if (!data || !data.Annotations) {
      retries++;
      if (retries > 5) {
        console.log(`Too many retries at page ${page}. Saving progress and stopping.`);
        break;
      }
      console.log(`  Retry ${retries}/5 for page ${page}...`);
      await sleep(2000);
      continue;
    }

    retries = 0;

    if (page === startPage && data.Annotations.TotalPages) {
      totalPages = data.Annotations.TotalPages;
      console.log(`  Confirmed TotalPages: ${totalPages}`);
    }

    const annotations = data.Annotations.Annotation || [];
    totalSaved += annotations.length;

    // Write this page as its own file — no memory accumulation
    const pageFile = path.join(OUTDIR, `page_${String(page).padStart(4, '0')}.json`);
    fs.writeFileSync(pageFile, JSON.stringify(annotations));

    // Update progress
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
      lastPage: page,
      totalSaved,
      timestamp: new Date().toISOString()
    }));

    if (page % 10 === 0) {
      console.log(`  Page ${page}/${totalPages} — ${totalSaved} total annotations — ${annotations.length} this page`);
    }

    page++;
  }

  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    lastPage: page - 1,
    totalSaved,
    timestamp: new Date().toISOString(),
    complete: page > totalPages
  }));

  console.log(`\n=== COMPLETE ===`);
  console.log(`Total annotations: ${totalSaved}`);
  console.log(`Saved as per-page files in: ${OUTDIR}`);
}

main().catch(console.error);
