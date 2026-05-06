const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTDIR = path.join(os.homedir(), 'pubchem_annotations');
const tmpFile = path.join(__dirname, 'tmp_ann.sql');

function runSQL(sql) {
  fs.writeFileSync(tmpFile, sql);
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
      cwd: __dirname, timeout: 30000, stdio: 'pipe', shell: true
    });
    return true;
  } catch(e) { return false; }
}

function parseAnnotations(filePath, heading) {
  if (!fs.existsSync(filePath)) return [];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data.map(ann => {
    const cids = ann.LinkedRecords?.CID || [];
    const values = [];
    for (const d of (ann.Data || [])) {
      for (const swm of (d.Value?.StringWithMarkup || [])) {
        if (swm.String) values.push(swm.String);
      }
    }
    return {
      source_name: ann.SourceName || '',
      source_id: ann.SourceID || '',
      name: ann.Name || '',
      url: ann.URL || '',
      cid: cids[0] || null,
      value: values.join(' | ').substring(0, 500),
      heading
    };
  });
}

// Parse all files
const all = [
  ...parseAnnotations(path.join(OUTDIR, 'jecfa_number.json'), 'JECFA Number'),
  ...parseAnnotations(path.join(OUTDIR, 'jecfa_evaluations.json'), 'JECFA Evaluation'),
  ...parseAnnotations(path.join(OUTDIR, 'eu_food_improvement.json'), 'EU Food Improvement'),
  ...parseAnnotations(path.join(OUTDIR, 'fda_saf.json'), 'FDA SAF'),
];

console.log(`Total annotations to import: ${all.length}`);

const BATCH = 50;
let imported = 0;

for (let i = 0; i < all.length; i += BATCH) {
  const batch = all.slice(i, i + BATCH);
  const values = batch.map(r => {
    const esc = (v) => v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
    return `(${esc(r.source_name)},${esc(r.source_id)},${esc(r.name)},${esc(r.url)},${esc(r.cid)},${esc(r.value)},${esc(r.heading)})`;
  }).join(',\n');

  if (runSQL(`INSERT INTO pubchem_regulatory_annotations (source_name,source_id,substance_name,url,cid,annotation_value,heading) VALUES ${values}`)) {
    imported += batch.length;
  }
  if (imported % 1000 === 0 || i + BATCH >= all.length) {
    console.log(`Imported ${imported}/${all.length}`);
  }
}

try { fs.unlinkSync(tmpFile); } catch(e) {}
console.log(`Done! ${imported} regulatory annotations imported.`);
