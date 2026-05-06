const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'pubchem-enrichment.json'), 'utf8'));
console.log(`Importing ${data.length} PubChem enrichment records...`);

const tmpFile = path.join(__dirname, 'tmp_pub.sql');

// Step 1: Create temp table (single statement = works with --file)
fs.writeFileSync(tmpFile, "CREATE TABLE IF NOT EXISTS _pubchem_temp (id INTEGER PRIMARY KEY, cid INTEGER, formula TEXT, weight REAL, iupac TEXT, inchikey TEXT, xlogp REAL)");
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
    cwd: __dirname, timeout: 15000, stdio: 'pipe', shell: true
  });
  console.log('Created temp table');
} catch(e) {
  console.error('Temp table error:', e.stderr?.toString().substring(0, 200));
  process.exit(1);
}

// Step 2: INSERT batches (single INSERT per file = works)
const BATCH_SIZE = 50;
let imported = 0;

for (let i = 0; i < data.length; i += BATCH_SIZE) {
  const batch = data.slice(i, i + BATCH_SIZE);
  const values = batch.map(r => {
    const esc = (v) => v == null || v === '' ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v;
    return `(${r.id},${esc(r.cid)},${esc(r.formula)},${esc(r.weight)},${esc(r.iupac)},${esc(r.inchikey)},${esc(r.xlogp)})`;
  }).join(',\n');

  fs.writeFileSync(tmpFile, `INSERT OR REPLACE INTO _pubchem_temp (id,cid,formula,weight,iupac,inchikey,xlogp) VALUES ${values}`);

  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
      cwd: __dirname, timeout: 30000, stdio: 'pipe', shell: true
    });
    imported += batch.length;
    if (imported % 500 === 0 || i + BATCH_SIZE >= data.length) {
      console.log(`Inserted ${imported}/${data.length}`);
    }
  } catch(e) {
    console.error(`Error batch ${i}: ${e.stderr?.toString().substring(0, 150)}`);
  }
}

// Step 3: UPDATE from temp (single statement)
console.log('Merging into food_additives...');
fs.writeFileSync(tmpFile, `UPDATE food_additives SET pubchem_cid = (SELECT cid FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), molecular_formula = (SELECT formula FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), molecular_weight = (SELECT weight FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), iupac_name = (SELECT iupac FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), inchikey = (SELECT inchikey FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), xlogp = (SELECT xlogp FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id) WHERE id IN (SELECT id FROM _pubchem_temp)`);

try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
    cwd: __dirname, timeout: 60000, stdio: 'pipe', shell: true
  });
  console.log('Merge complete!');
} catch(e) {
  console.error('Merge error:', e.stderr?.toString().substring(0, 300));
}

// Step 4: Cleanup
fs.writeFileSync(tmpFile, "DROP TABLE IF EXISTS _pubchem_temp");
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
    cwd: __dirname, timeout: 15000, stdio: 'pipe', shell: true
  });
  console.log('Cleanup done!');
} catch(e) {}

try { fs.unlinkSync(tmpFile); } catch(e) {}
console.log(`Complete! ${imported} records processed.`);
