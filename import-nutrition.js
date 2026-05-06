const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync('C:/BENDA_PROJECT/ROOTS_BY_BENDA/04_SAFETY_DATA/data_gov_il/moh_nutrition_database.json', 'utf8'));
console.log(`Total nutrition records: ${data.length}`);

const BATCH_SIZE = 50;
let imported = 0;

for (let i = 0; i < data.length; i += BATCH_SIZE) {
  const batch = data.slice(i, i + BATCH_SIZE);
  const values = batch.map(r => {
    const esc = (v) => v == null || v === '' ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v;
    return `(${esc(r.Code)}, ${esc(r.smlmitzrach)}, ${esc(r.shmmitzrach)}, ${esc(r.english_name)}, ${esc(r.protein)}, ${esc(r.total_fat)}, ${esc(r.carbohydrates)}, ${esc(r.food_energy)}, ${esc(r.moisture)}, ${esc(r.total_dietary_fiber)}, ${esc(r.total_sugars)}, ${esc(r.calcium)}, ${esc(r.iron)}, ${esc(r.magnesium)}, ${esc(r.phosphorus)}, ${esc(r.potassium)}, ${esc(r.sodium)}, ${esc(r.zinc)}, ${esc(r.vitamin_a_iu)}, ${esc(r.vitamin_c)}, ${esc(r.vitamin_e)}, ${esc(r.vitamin_d)}, ${esc(r.vitamin_k)}, ${esc(r.vitamin_b6)}, ${esc(r.vitamin_b12)}, ${esc(r.thiamin)}, ${esc(r.riboflavin)}, ${esc(r.niacin)}, ${esc(r.folate)}, ${esc(r.cholesterol)}, ${esc(r.saturated_fat)}, ${esc(r.mono_unsaturated_fat)}, ${esc(r.poly_unsaturated_fat)}, ${esc(r.trans_fatty_acids)}, ${esc(r.selenium)}, ${esc(r.choline)}, ${esc(r.alcohol)})`;
  }).join(',\n');

  const sql = `INSERT INTO moh_nutrition (code, smlmitzrach, hebrew_name, english_name, protein, total_fat, carbohydrates, food_energy, moisture, total_dietary_fiber, total_sugars, calcium, iron, magnesium, phosphorus, potassium, sodium, zinc, vitamin_a_iu, vitamin_c, vitamin_e, vitamin_d, vitamin_k, vitamin_b6, vitamin_b12, thiamin, riboflavin, niacin, folate, cholesterol, saturated_fat, mono_unsaturated_fat, poly_unsaturated_fat, trans_fatty_acids, selenium, choline, alcohol) VALUES ${values}`;

  const tmpFile = path.join(__dirname, 'tmp_sql.sql');
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
      console.log(`Imported ${imported}/${data.length} nutrition records`);
    }
  } catch (e) {
    console.error(`Error at batch ${i}: ${e.stderr ? e.stderr.toString().substring(0, 200) : e.message.substring(0, 200)}`);
  }
}

try { fs.unlinkSync(path.join(__dirname, 'tmp_sql.sql')); } catch(e) {}
console.log(`Done! Total imported: ${imported}`);
