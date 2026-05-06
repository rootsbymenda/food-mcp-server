const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync('C:/BENDA_PROJECT/ROOTS_BY_BENDA/04_SAFETY_DATA/data_gov_il/moh_pesticide_residues_mrl.json', 'utf8'));
console.log(`Total pesticide MRL records: ${data.length}`);

const BATCH_SIZE = 100;
let imported = 0;

for (let i = 0; i < data.length; i += BATCH_SIZE) {
  const batch = data.slice(i, i + BATCH_SIZE);
  const values = batch.map(r => {
    const esc = (v) => v == null || v === '' ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v;
    const substance = r['\u05d7\u05d5\u05de\u05e8_\u05e4\u05e2\u05d9\u05dc'] || r['חומר_פעיל'] || '';
    const cropHe = r['\u05d2\u05d9\u05d3\u05d5\u05dc'] || r['גידול'] || '';
    const cropEn = r['\u05d2\u05d9\u05d3\u05d5\u05dc_\u05d0\u05e0\u05d2\u05dc\u05d9'] || r['גידול_אנגלי'] || '';
    const mrl = r['MRL'];
    const date = r['\u05ea\u05d0\u05e8\u05d9\u05da_\u05e2\u05d3\u05db\u05d5\u05df'] || r['תאריך_עדכון'] || '';
    const pending = r['MRL_\u05d1\u05d4\u05de\u05ea\u05e0\u05d4'] || r['MRL_בהמתנה'] || '';
    return `(${esc(substance)}, ${esc(cropHe)}, ${esc(cropEn)}, ${esc(mrl)}, ${esc(date)}, ${esc(pending)})`;
  }).join(',\n');

  const sql = `INSERT INTO il_pesticide_mrl (active_substance, crop_hebrew, crop_english, mrl_value, update_date, mrl_pending) VALUES ${values}`;

  const tmpFile = path.join(__dirname, 'tmp_pest_sql.sql');
  fs.writeFileSync(tmpFile, sql);

  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'benda-ingredients', '--remote', `--file=${tmpFile}`], {
      cwd: __dirname,
      timeout: 30000,
      stdio: 'pipe',
      shell: true
    });
    imported += batch.length;
    if (imported % 500 === 0 || i + BATCH_SIZE >= data.length) {
      console.log(`Imported ${imported}/${data.length} pesticide MRL records`);
    }
  } catch (e) {
    console.error(`Error at batch ${i}: ${e.stderr ? e.stderr.toString().substring(0, 200) : e.message.substring(0, 200)}`);
  }
}

try { fs.unlinkSync(path.join(__dirname, 'tmp_pest_sql.sql')); } catch(e) {}
console.log(`Done! Total imported: ${imported}`);
