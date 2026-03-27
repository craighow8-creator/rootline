#!/usr/bin/env node
// ============================================================
// ROOTLINE — FreeBMD Import Script
// import.js
//
// Downloads FreeBMD bulk data and imports into Cloudflare D1
//
// Usage:
//   node import.js --type=births --year-from=1837 --year-to=1920
//   node import.js --type=all --county=Yorkshire
//   node import.js --file=./data/births.csv --type=births
//
// Requirements:
//   npm install csv-parse commander
//   wrangler must be installed and authenticated
// ============================================================

const { parse }   = require('csv-parse');
const { program } = require('commander');
const fs          = require('fs');
const path        = require('path');
const { execSync, spawn } = require('child_process');

program
  .option('--type <type>',       'Record type: births, marriages, deaths, all', 'all')
  .option('--file <file>',       'Path to local CSV file (skips download)')
  .option('--year-from <year>',  'Start year', '1837')
  .option('--year-to <year>',    'End year',   '1920')
  .option('--county <county>',   'Filter by county (optional)')
  .option('--db <db>',           'D1 database name', 'rootline-db')
  .option('--batch-size <size>', 'Insert batch size', '500')
  .option('--dry-run',           'Parse only, do not insert')
  .parse();

const opts = program.opts();

// ── FreeBMD data URLs ──────────────────────────────────────
// FreeBMD provides bulk downloads at freebmd.org.uk/big_file.html
// Files are split by record type and year range
// Note: FreeBMD requires you agree to their terms before downloading
// Visit: https://www.freebmd.org.uk/big_file.html

const FREEBMD_BASE = 'https://www.freebmd.org.uk/data';

const DATA_FILES = {
  births: [
    'births_1837_1900.csv.gz',
    'births_1901_1950.csv.gz',
    'births_1951_1983.csv.gz',
  ],
  marriages: [
    'marriages_1837_1900.csv.gz',
    'marriages_1901_1950.csv.gz',
    'marriages_1951_1983.csv.gz',
  ],
  deaths: [
    'deaths_1837_1900.csv.gz',
    'deaths_1901_1950.csv.gz',
    'deaths_1951_1983.csv.gz',
  ],
};

// ── CSV column mappings ────────────────────────────────────
// FreeBMD CSV format (may vary slightly by year range):
const COLUMNS = {
  births: {
    surname:        0,
    forename:       1,
    mother_surname: 2,  // only present post-1911
    district:       3,
    county:         4,
    year:           5,
    quarter:        6,
    volume:         7,
    page:           8,
  },
  marriages: {
    surname:        0,
    forename:       1,
    spouse_surname: 2,
    district:       3,
    county:         4,
    year:           5,
    quarter:        6,
    volume:         7,
    page:           8,
  },
  deaths: {
    surname:  0,
    forename: 1,
    age:      2,
    district: 3,
    county:   4,
    year:     5,
    quarter:  6,
    volume:   7,
    page:     8,
  },
};

// ── Quarter mapping ────────────────────────────────────────
// FreeBMD uses Mar/Jun/Sep/Dec — convert to 1/2/3/4
const QUARTER_MAP = {
  'Mar': 1, 'Jun': 2, 'Sep': 3, 'Dec': 4,
  '1': 1,   '2': 2,   '3': 3,   '4': 4,
  'Q1': 1,  'Q2': 2,  'Q3': 3,  'Q4': 4,
};

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log('\n📜 ROOTLINE — FreeBMD Import Tool');
  console.log('══════════════════════════════════\n');

  const types = opts.type === 'all'
    ? ['births', 'marriages', 'deaths']
    : [opts.type];

  for (const type of types) {
    console.log(`\n▶ Processing ${type}...`);

    if (opts.file) {
      await importFile(opts.file, type);
    } else {
      await importFromFreeBMD(type);
    }
  }

  console.log('\n✅ Import complete.');
  console.log('Run: wrangler d1 execute rootline-db --command="SELECT COUNT(*) FROM births"');
  console.log('to verify the data loaded correctly.\n');
}

async function importFromFreeBMD(type) {
  console.log(`\n⚠️  FreeBMD Bulk Download Instructions for ${type}:`);
  console.log('─────────────────────────────────────────────────');
  console.log('1. Visit: https://www.freebmd.org.uk/big_file.html');
  console.log('2. Agree to FreeBMD terms of use');
  console.log(`3. Download the ${type} CSV files for your required years`);
  console.log('4. Place the files in ./data/ folder');
  console.log(`5. Run: node import.js --file=./data/${type}.csv --type=${type}`);
  console.log('\nAlternatively, FreeBMD county-specific files are smaller.');
  console.log('For Yorkshire only: filter after download using --county=Yorkshire\n');

  // Check if data files already exist locally
  const dataDir = path.join(process.cwd(), 'data');
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir).filter(f => f.includes(type));
    if (files.length) {
      console.log(`Found local files: ${files.join(', ')}`);
      for (const file of files) {
        await importFile(path.join(dataDir, file), type);
      }
      return;
    }
  }

  console.log('No local data files found. Please download from FreeBMD first.');
}

async function importFile(filePath, type) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return;
  }

  console.log(`📂 Reading: ${filePath}`);

  const cols     = COLUMNS[type];
  const yearFrom = parseInt(opts.yearFrom);
  const yearTo   = parseInt(opts.yearTo);
  const county   = opts.county?.toLowerCase();
  const batchSize = parseInt(opts.batchSize);

  let rows    = [];
  let total   = 0;
  let skipped = 0;
  let batches = 0;

  const parser = fs.createReadStream(filePath).pipe(
    parse({
      skip_empty_lines: true,
      trim: true,
      from_line: 2, // skip header
    })
  );

  for await (const row of parser) {
    // Year filter
    const year = parseInt(row[cols.year]);
    if (isNaN(year) || year < yearFrom || year > yearTo) { skipped++; continue; }

    // County filter
    if (county && row[cols.county]?.toLowerCase().indexOf(county) === -1) {
      skipped++;
      continue;
    }

    // Privacy: skip anything that could relate to living people
    if (year > new Date().getFullYear() - 100) { skipped++; continue; }

    // Build record
    const record = buildRecord(type, row, cols);
    if (!record) { skipped++; continue; }

    rows.push(record);
    total++;

    // Insert in batches
    if (rows.length >= batchSize) {
      if (!opts.dryRun) await insertBatch(type, rows);
      batches++;
      process.stdout.write(`\r  Inserted: ${total.toLocaleString()} records (${batches} batches)...`);
      rows = [];
    }
  }

  // Final batch
  if (rows.length && !opts.dryRun) {
    await insertBatch(type, rows);
    batches++;
  }

  console.log(`\n  ✓ ${total.toLocaleString()} records imported, ${skipped.toLocaleString()} skipped`);
}

function buildRecord(type, row, cols) {
  try {
    const year    = parseInt(row[cols.year]);
    const quarter = QUARTER_MAP[row[cols.quarter]] || parseInt(row[cols.quarter]) || null;
    const surname = row[cols.surname]?.trim();

    if (!surname || !year) return null;

    if (type === 'births') {
      return {
        surname,
        forename:       row[cols.forename]?.trim() || '',
        mother_surname: row[cols.mother_surname]?.trim() || '',
        district:       row[cols.district]?.trim() || '',
        county:         row[cols.county]?.trim() || '',
        year,
        quarter,
        volume:         row[cols.volume]?.trim() || '',
        page:           row[cols.page]?.trim() || '',
      };
    }

    if (type === 'marriages') {
      return {
        surname,
        forename:       row[cols.forename]?.trim() || '',
        spouse_surname: row[cols.spouse_surname]?.trim() || '',
        district:       row[cols.district]?.trim() || '',
        county:         row[cols.county]?.trim() || '',
        year,
        quarter,
        volume:         row[cols.volume]?.trim() || '',
        page:           row[cols.page]?.trim() || '',
      };
    }

    if (type === 'deaths') {
      return {
        surname,
        forename: row[cols.forename]?.trim() || '',
        age:      parseInt(row[cols.age]) || null,
        district: row[cols.district]?.trim() || '',
        county:   row[cols.county]?.trim() || '',
        year,
        quarter,
        volume:   row[cols.volume]?.trim() || '',
        page:     row[cols.page]?.trim() || '',
      };
    }

  } catch (e) {
    return null;
  }
}

async function insertBatch(type, rows) {
  // Generate SQL for batch insert
  const placeholders = rows.map(() => {
    if (type === 'births')    return '(?,?,?,?,?,?,?,?,?)';
    if (type === 'marriages') return '(?,?,?,?,?,?,?,?,?)';
    if (type === 'deaths')    return '(?,?,?,?,?,?,?,?,?)';
  }).join(',\n');

  const values = rows.flatMap(r => {
    if (type === 'births')    return [r.surname, r.forename, r.mother_surname, r.district, r.county, r.year, r.quarter, r.volume, r.page];
    if (type === 'marriages') return [r.surname, r.forename, r.spouse_surname, r.district, r.county, r.year, r.quarter, r.volume, r.page];
    if (type === 'deaths')    return [r.surname, r.forename, r.age, r.district, r.county, r.year, r.quarter, r.volume, r.page];
  });

  const cols = {
    births:    '(surname, forename, mother_surname, district, county, year, quarter, volume, page)',
    marriages: '(surname, forename, spouse_surname, district, county, year, quarter, volume, page)',
    deaths:    '(surname, forename, age, district, county, year, quarter, volume, page)',
  };

  // Write to temp SQL file and execute via wrangler
  const sql = `INSERT OR IGNORE INTO ${type} ${cols[type]} VALUES ${placeholders};`;
  const tmpFile = `/tmp/rootline_batch_${Date.now()}.sql`;

  // Replace ? with actual values (D1 batch insert via wrangler CLI)
  let i = 0;
  const filledSql = sql.replace(/\?/g, () => {
    const v = values[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    return `'${String(v).replace(/'/g, "''")}'`;
  });

  fs.writeFileSync(tmpFile, filledSql);

  try {
    execSync(`wrangler d1 execute ${opts.db} --file=${tmpFile}`, { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

main().catch(err => {
  console.error('\n❌ Import failed:', err.message);
  process.exit(1);
});
