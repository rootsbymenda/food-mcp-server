const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTDIR = path.join(os.homedir(), 'pubchem_annotations');
const tmpFile = path.join(__dirname, 'tmp_safety.sql');

function esc(v) {
  if (v == null || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''").substring(0, 500)}'`;
}

function runSQL(sql) {
  fs.writeFileSync(tmpFile, sql);
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
      cwd: __dirname, timeout: 30000, stdio: 'pipe', shell: true
    });
    return true;
  } catch(e) { return false; }
}

// Create table
runSQL("CREATE TABLE IF NOT EXISTS pubchem_safety_annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_name TEXT, substance_name TEXT, cid INTEGER, heading TEXT, annotation_value TEXT, url TEXT)");
console.log('Table created');

const files = [
  ['carcinogen_classification.json', 'Carcinogen Classification'],
  ['evidence_carcinogenicity.json', 'Evidence for Carcinogenicity'],
  ['endocrine_disruptors.json', 'Endocrine Disruptors'],
  ['icsc_number.json', 'ICSC Safety Card'],
  ['irritation.json', 'Skin Eye Respiratory Irritation'],
];

let total = 0;

for (const [file, heading] of files) {
  const fpath = path.join(OUTDIR, file);
  if (!fs.existsSync(fpath)) { console.log(`Skip: ${file}`); continue; }
  const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  console.log(`\n${heading}: ${data.length} records`);

  let imported = 0;
  for (let i = 0; i < data.length; i += 50) {
    const batch = data.slice(i, i + 50);
    const vals = batch.map(ann => {
      const cids = ann.LinkedRecords?.CID || [];
      const values = [];
      for (const d of (ann.Data || [])) {
        for (const swm of (d.Value?.StringWithMarkup || [])) {
          if (swm.String) values.push(swm.String);
        }
      }
      return `(${esc(ann.SourceName)},${esc(ann.Name)},${esc(cids[0])},${esc(heading)},${esc(values.join(' | '))},${esc(ann.URL)})`;
    }).join(',\n');

    if (runSQL(`INSERT INTO pubchem_safety_annotations (source_name,substance_name,cid,heading,annotation_value,url) VALUES ${vals}`)) {
      imported += batch.length;
    }
    if (imported % 1000 === 0 || i + 50 >= data.length) console.log(`  ${imported}/${data.length}`);
  }
  total += imported;
}

try { fs.unlinkSync(tmpFile); } catch(e) {}
console.log(`\nDone! ${total} safety annotations imported.`);
