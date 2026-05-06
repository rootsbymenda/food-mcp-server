const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'pubchem-enrichment.json'), 'utf8'));
console.log(`Importing ${data.length} PubChem enrichment records...`);
const tmpFile = path.join(__dirname, 'tmp_pub.sql');

function runSQL(sql, label) {
  fs.writeFileSync(tmpFile, sql);
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`, '--yes'], {
      cwd: __dirname, timeout: 60000, stdio: 'pipe', shell: true
    });
    if (label) console.log(label);
    return true;
  } catch(e) {
    console.error(`FAIL [${label}]: ${e.stderr?.toString().substring(0, 150)}`);
    return false;
  }
}

// Step 1
runSQL("CREATE TABLE IF NOT EXISTS _pubchem_temp (id INTEGER PRIMARY KEY, cid INTEGER, formula TEXT, weight REAL, iupac TEXT, inchikey TEXT, xlogp REAL)", "1/4 Temp table created");

// Step 2: INSERT
const BATCH_SIZE = 50;
let imported = 0;
for (let i = 0; i < data.length; i += BATCH_SIZE) {
  const batch = data.slice(i, i + BATCH_SIZE);
  const values = batch.map(r => {
    const esc = (v) => v == null || v === '' ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v;
    return `(${r.id},${esc(r.cid)},${esc(r.formula)},${esc(r.weight)},${esc(r.iupac)},${esc(r.inchikey)},${esc(r.xlogp)})`;
  }).join(',\n');
  if (runSQL(`INSERT OR REPLACE INTO _pubchem_temp (id,cid,formula,weight,iupac,inchikey,xlogp) VALUES ${values}`)) {
    imported += batch.length;
  }
  if (imported % 500 === 0 || i + BATCH_SIZE >= data.length) console.log(`2/4 Inserted ${imported}/${data.length}`);
}

// Step 3: MERGE
runSQL(`UPDATE food_additives SET pubchem_cid = (SELECT cid FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), molecular_formula = (SELECT formula FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), molecular_weight = (SELECT weight FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), iupac_name = (SELECT iupac FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), inchikey = (SELECT inchikey FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id), xlogp = (SELECT xlogp FROM _pubchem_temp WHERE _pubchem_temp.id = food_additives.id) WHERE id IN (SELECT id FROM _pubchem_temp)`, "3/4 Merge complete!");

// Step 4: Cleanup
runSQL("DROP TABLE IF EXISTS _pubchem_temp", "4/4 Cleanup done!");

try { fs.unlinkSync(tmpFile); } catch(e) {}
console.log(`DONE! ${imported} records enriched.`);
