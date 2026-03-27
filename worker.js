// ============================================================
// ROOTLINE — Cloudflare Worker v2.0
// rootline-worker/index.js
//
// Bindings required in wrangler.toml:
//   KV:      ROOTLINE_TREE
//   D1:      ROOTLINE_DB
//   Secrets: ANTHROPIC_API_KEY, CWGC_API_KEY (optional)
//
// D1 migration required (run once):
//   wrangler d1 execute ROOTLINE_DB --remote --command \
//     "CREATE TABLE IF NOT EXISTS scrape_cache (
//        cache_key    TEXT PRIMARY KEY,
//        source       TEXT NOT NULL,
//        results_json TEXT NOT NULL,
//        cached_at    TEXT NOT NULL
//      );"
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const CACHE_TTL_DAYS = 7;

// ── ROUTER ──────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      // Search endpoints
      if (path === '/api/search/cwgc'     && method === 'GET') return searchCWGC(url, env);
      if (path === '/api/search/bmd'      && method === 'GET') return searchBMD(url, env);
      if (path === '/api/search/census'   && method === 'GET') return searchCensus(url, env);
      if (path === '/api/search/scotland' && method === 'GET') return searchScotland(url);
      if (path === '/api/search/all'      && method === 'GET') return searchAll(url, env);

      // Tree endpoints
      if (path === '/api/tree'             && method === 'GET')    return getTree(env);
      if (path === '/api/tree'             && method === 'POST')   return addPerson(request, env);
      if (path.startsWith('/api/tree/')    && method === 'PUT')    return updatePerson(request, path, env);
      if (path.startsWith('/api/tree/')    && method === 'DELETE') return deletePerson(path, env);

      // AI endpoints
      if (path === '/api/ai/context'   && method === 'POST') return aiContext(request, env);
      if (path === '/api/ai/narrative' && method === 'POST') return aiNarrative(request, env);

      // Health check
      if (path === '/api/health' && method === 'GET') {
        return json({ status: 'ok', version: '2.0.0', sources: ['cwgc', 'freebmd', 'freecen', 'scotlandspeople'] });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  }
};

// ============================================================
// SEARCH — CWGC (unchanged)
// Commonwealth War Graves Commission — CSV export endpoint
// 1.7 million WWI + WWII casualties, no auth required
// ============================================================
async function searchCWGC(url, env) {
  const surname  = url.searchParams.get('surname')  || '';
  const forename = url.searchParams.get('forename') || '';

  if (!surname) return json({ error: 'surname is required' }, 400);

  const params = new URLSearchParams({
    Surname:         surname,
    ...(forename && { Forename: forename }),
    ServiceNumExact: 'false',
    Page:            '1',
    Tab:             'all',
  });

  const cwgcUrl = `https://www.cwgc.org/ExportCasualtySearch/?${params}`;

  let resp;
  try {
    resp = await fetch(cwgcUrl, {
      headers: {
        'Accept':     'text/csv,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; family-history-research)',
        'Referer':    'https://www.cwgc.org/find-records/find-war-dead/',
      }
    });
  } catch (e) {
    return json({ results: [], source: 'cwgc', count: 0, error: 'CWGC unreachable' });
  }

  if (!resp.ok) {
    return json({ results: [], source: 'cwgc', count: 0, error: `CWGC ${resp.status}` });
  }

  const csv     = await resp.text();
  const results = parseCWGCcsv(csv);

  await logSearch(env, 'cwgc', surname, null, null, null, results.length);

  return json({ results, source: 'cwgc', count: results.length });
}

function parseCWGCcsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const results = [];
  for (let i = 1; i < Math.min(lines.length, 101); i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 17) continue;

    const died = cols[6]?.trim() || '';
    results.push({
      id:          cols[0]?.trim(),
      source:      'cwgc',
      surname:     cols[1]?.trim() || '',
      forename:    (cols[2]?.trim() || cols[3]?.trim() || ''),
      age:         cols[4]?.trim() || null,
      honours:     cols[5]?.trim() || '',
      died,
      rank:        cols[8]?.trim()  || '',
      regiment:    cols[9]?.trim()  || '',
      unit:        cols[11]?.trim() || '',
      nationality: cols[13]?.trim() || 'United Kingdom',
      cemetery:    cols[16]?.trim() || '',
      grave_ref:   cols[17]?.trim() || '',
      next_of_kin: cols[18]?.trim() || '',
      conflict:    guessConflict(died),
      cwgc_url:    cols[0]?.trim()
        ? `https://www.cwgc.org/find-war-dead/casualty/${cols[0].trim()}`
        : '',
    });
  }
  return results;
}

// ============================================================
// SEARCH — FreeBMD (live scrape + D1 cache)
// England & Wales births, marriages, deaths 1837–present
// freebmd.org.uk — CGI search, js=0 returns plain HTML, no auth required
// Simple GET request — much more reliable than FreeBMD2 POST flow
// ============================================================
async function searchBMD(url, env) {
  const surname  = (url.searchParams.get('surname')  || '').trim().toUpperCase();
  const forename = (url.searchParams.get('forename') || '').trim();
  const type     = (url.searchParams.get('type')     || 'all'); // birth | marriage | death | all
  const yearFrom = url.searchParams.get('year_from') || '1837';
  const yearTo   = url.searchParams.get('year_to')   || '2005';
  const district = (url.searchParams.get('district') || url.searchParams.get('county') || '').trim();

  if (!surname) return json({ error: 'surname is required' }, 400);

  const cacheKey = `bmd:${surname}:${forename}:${type}:${yearFrom}:${yearTo}:${district}`.toLowerCase();

  const cached = await getCachedResults(env, cacheKey);
  if (cached) return json({ ...cached, cached: true });

  // FreeBMD CGI type parameter
  const typeMap = { birth: 'Births', marriage: 'Marriages', death: 'Deaths', all: 'All' };
  const cgiType = typeMap[type] || 'All';

  // year range — CGI uses year + range (± years around centre)
  // Simplest approach: use year=yearFrom, range = yearTo - yearFrom
  const centreYear = yearFrom;
  const range      = Math.max(0, parseInt(yearTo) - parseInt(yearFrom));

  const params = new URLSearchParams({
    type:      cgiType,
    lastname:  surname,
    firstname: forename || '',
    district:  district || '',
    year:      centreYear,
    range:     String(range),
    qtrs:      '5',   // all quarters
    js:        '0',   // plain HTML — no JavaScript rendering needed
    Submitbtn: 'Search',
  });

  const searchUrl = `https://www.freebmd.org.uk/cgi/search.pl?${params}`;

  let html;
  try {
    const resp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*',
        'Referer':    'https://www.freebmd.org.uk/search',
      }
    });
    if (!resp.ok) throw new Error(`FreeBMD ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    return json({ results: [], source: 'freebmd', count: 0, error: `FreeBMD unavailable: ${e.message}` });
  }

  const results = parseFreeBMDHtml(html, surname, searchUrl);

  const payload = {
    results,
    source:     'freebmd',
    coverage:   'England & Wales, 1837–present',
    count:      results.length,
    search_url: searchUrl,
    cached:     false,
  };

  await cacheResults(env, cacheKey, 'freebmd', payload);
  await logSearch(env, 'freebmd', surname, district, yearFrom, yearTo, results.length);

  return json(payload);
}

function parseFreeBMDHtml(html, surname, searchUrl) {
  const results = [];

  // FreeBMD js=0 results table columns (varies by record type):
  // Births:    First name(s) | Surname | Mother's maiden name | District | Vol | Page | Year | Quarter
  // Marriages: First name(s) | Surname | Spouse surname       | District | Vol | Page | Year | Quarter
  // Deaths:    First name(s) | Surname | Age                  | District | Vol | Page | Year | Quarter

  // The table has a header row with these labels — detect it then parse rows
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let inTable = false;
  let recordType = null;

  // Detect record type from section headers in the page
  // FreeBMD wraps each type in a section headed "Births", "Marriages", "Deaths"
  let currentSection = null;
  const sectionRegex = /class="[^"]*section[^"]*"[^>]*>\s*(?:<[^>]+>)?\s*(Births|Marriages|Deaths)/gi;
  let sectionMatch;
  const sectionPositions = [];
  while ((sectionMatch = sectionRegex.exec(html)) !== null) {
    sectionPositions.push({ type: sectionMatch[1], pos: sectionMatch.index });
  }

  // Parse all <tr> rows
  const allRows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    allRows.push({ content: rowMatch[1], pos: rowMatch.index });
  }

  for (const row of allRows) {
    // Determine which section this row falls under
    let section = 'All';
    for (const sp of sectionPositions) {
      if (row.pos > sp.pos) section = sp.type;
    }

    const cells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(row.content)) !== null) {
      cells.push(
        tdMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g,  '&')
          .replace(/&nbsp;/g, ' ')
          .replace(/&#160;/g, ' ')
          .replace(/\s+/g,    ' ')
          .trim()
      );
    }

    // Need at least 7 cells: name, surname, extra, district, vol, page, year (+ optional quarter)
    if (cells.length < 7) continue;

    // Skip header rows
    if (/first\s*name|surname|district|quarter/i.test(cells[0])) continue;

    const forename     = cells[0] || '';
    const parsedSurn   = cells[1] || surname;
    const extra        = cells[2] || '';   // MMN / spouse / age
    const district     = cells[3] || '';
    const volume       = cells[4] || '';
    const page         = cells[5] || '';
    const year         = parseInt(cells[6]) || null;
    const quarterRaw   = cells[7] || '';
    const quarter      = parseFreeBMDQuarter(quarterRaw);

    if (!forename && !parsedSurn) continue;
    if (!year) continue;

    // Map section name to record_type string
    const typeStr = section === 'Births'    ? 'Birth'
                  : section === 'Marriages' ? 'Marriage'
                  : section === 'Deaths'    ? 'Death'
                  : 'Unknown';

    if (typeStr === 'Unknown') continue;

    results.push({
      source:         'freebmd',
      record_type:    typeStr,
      surname:        parsedSurn,
      forename,
      year,
      quarter,
      district,
      volume,
      page,
      mothers_maiden: typeStr === 'Birth'    ? (extra || null) : null,
      spouse_surname: typeStr === 'Marriage' ? (extra || null) : null,
      age_at_death:   typeStr === 'Death'    ? (extra || null) : null,
      source_url:     searchUrl,
    });

    if (results.length >= 50) break;
  }

  return results;
}

function parseFreeBMDQuarter(q) {
  if (!q) return null;
  if (q === 'Mar' || q === '1') return 'Q1 (Jan–Mar)';
  if (q === 'Jun' || q === '2') return 'Q2 (Apr–Jun)';
  if (q === 'Sep' || q === '3') return 'Q3 (Jul–Sep)';
  if (q === 'Dec' || q === '4') return 'Q4 (Oct–Dec)';
  return q;
}

// ============================================================
// PRIVACY — Redaction helpers
// Records within last 100 years are shown but sensitive fields masked
// ============================================================
function redactName(name) {
  if (!name || name.length <= 1) return '*';
  return name.charAt(0) + '*'.repeat(Math.min(name.length - 1, 3));
}

function redactPlace(place) {
  if (!place || place.length <= 3) return '***';
  return place.slice(0, 3) + '*'.repeat(Math.min(place.length - 3, 4));
}

function redactRecord(r) {
  return {
    ...r,
    forename:      redactName(r.forename),
    surname:       redactName(r.surname),
    district:      redactPlace(r.district),
    county:        redactPlace(r.county),
    volume:        '***',
    page:          '***',
    source_url:    null,   // no deep-link for redacted records
    redacted:      true,
    redacted_note: 'This record is within 100 years. Some fields are hidden to protect personal data.',
  };
}

// ============================================================
// SEARCH — FreeCen (live scrape + D1 cache)
// UK Census 1841–1891 transcriptions
// freecen.org.uk — server-rendered, no auth required
// Yorkshire coverage is strong
// ============================================================
async function searchCensus(url, env) {
  const surname  = (url.searchParams.get('surname')  || '').trim().toUpperCase();
  const forename = (url.searchParams.get('forename') || '').trim();
  const year     = url.searchParams.get('year')      || '';  // census year: 1841|1851|1861|1871|1881|1891
  const county   = url.searchParams.get('county')    || '';  // e.g. Yorkshire

  if (!surname) return json({ error: 'surname is required' }, 400);

  const cacheKey = `census:${surname}:${forename}:${year}:${county}`.toLowerCase();

  const cached = await getCachedResults(env, cacheKey);
  if (cached) return json({ ...cached, cached: true });

  // FreeCen search URL — server-rendered results page
  const freecenParams = new URLSearchParams();
  freecenParams.set('search_query[surname]',        surname);
  freecenParams.set('search_query[surname_exact]',  'false');
  if (forename) freecenParams.set('search_query[forename]', forename);
  if (year)     freecenParams.set('search_query[year]',     year);
  if (county)   freecenParams.set('search_query[county]',   county);
  freecenParams.set('search_query[country]', 'England and Wales');

  const scrapeUrl = `https://www.freecen.org.uk/search_queries/new?${freecenParams}`;

  // Also build a supplementary FindMyPast deep-link (requires account but useful signpost)
  const findmypastUrl = buildFindMyPastCensusUrl(surname, forename, year);

  let html;
  try {
    const resp = await fetch(scrapeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; personal-family-history-research)',
        'Accept':     'text/html,*/*',
        'Referer':    'https://www.freecen.org.uk/',
      }
    });
    if (!resp.ok) throw new Error(`FreeCen ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    // FreeCen down — return deep-links only
    return json({
      results:         [],
      source:          'freecen',
      coverage:        'England & Wales census 1841–1891',
      count:           0,
      error:           `FreeCen unavailable: ${e.message}`,
      search_url:      scrapeUrl,
      supplementary:   buildCensusSupplementary(surname, forename, year, scrapeUrl, findmypastUrl),
      cached:          false,
    });
  }

  const results = parseFreeCenHtml(html, surname);

  const payload = {
    results,
    source:        'freecen',
    coverage:      'England & Wales & Scotland census 1841–1891',
    count:         results.length,
    search_url:    scrapeUrl,
    supplementary: buildCensusSupplementary(surname, forename, year, scrapeUrl, findmypastUrl),
    cached:        false,
  };

  await cacheResults(env, cacheKey, 'freecen', payload);
  await logSearch(env, 'freecen', surname, county, year || null, null, results.length);

  return json(payload);
}

function parseFreeCenHtml(html, surname) {
  const results = [];

  // FreeCen results table columns:
  // Surname | Forename | Age | Sex | Birth year | Birth county | Census year | County | District | Piece

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let inResultsTable = false;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const row = trMatch[1];

    // Detect header row
    if (/\bSurname\b.*\bAge\b.*\bCensus\b/i.test(row) || /\bForename\b.*\bBirth\b.*\bCounty\b/i.test(row)) {
      inResultsTable = true;
      continue;
    }

    if (!inResultsTable) continue;

    const cells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(row)) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim());
    }

    if (cells.length < 6) continue;

    // Skip rows that look like headers or separators
    if (/surname/i.test(cells[0])) continue;

    const censusYear = parseInt(cells[6]) || null;
    const birthYear  = parseInt(cells[4]) || null;

    results.push({
      source:       'freecen',
      surname:      cells[0] || surname,
      forename:     cells[1] || '',
      age:          cells[2] || null,
      sex:          cells[3] || null,
      birth_year:   birthYear,
      birth_county: cells[5] || '',
      census_year:  censusYear,
      county:       cells[7] || '',
      district:     cells[8] || '',
      piece:        cells[9] || '',
    });

    if (results.length >= 50) break;
  }

  return results;
}

function buildFindMyPastCensusUrl(surname, forename, year) {
  const base = 'https://www.findmypast.co.uk/search/results?sourcecountry=great%20britain&collection=1911-england-and-wales-census';
  const params = new URLSearchParams({
    lastname:  surname,
    ...(forename && { firstname: forename }),
  });
  return `https://www.findmypast.co.uk/search/results?${params}`;
}

function buildCensusSupplementary(surname, forename, year, freecenUrl, findmypastUrl) {
  return [
    {
      name:        'FreeCen',
      description: 'Free census transcriptions 1841–1891',
      url:         freecenUrl,
      free:        true,
    },
    {
      name:        'FindMyPast',
      description: 'Full census images 1841–1911 (subscription)',
      url:         findmypastUrl,
      free:        false,
    },
    {
      name:        'Ancestry',
      description: 'Census, parish records, military (subscription)',
      url:         `https://www.ancestry.co.uk/search/?name=${encodeURIComponent(forename)}_${encodeURIComponent(surname)}&name_x=1`,
      free:        false,
    },
  ];
}

// ============================================================
// SEARCH — ScotlandsPeople (deep-link only)
// Automated access not feasible — modern SPA, ToS prohibits scraping
// Returns a pre-built search URL the user can open in browser
// ============================================================
function searchScotland(url) {
  const surname  = (url.searchParams.get('surname')  || '').trim();
  const forename = (url.searchParams.get('forename') || '').trim();
  const type     = url.searchParams.get('type')      || ''; // birth|marriage|death|census

  if (!surname) return json({ error: 'surname is required' }, 400);

  // ScotlandsPeople quick search URL
  const spParams = new URLSearchParams({
    surname,
    ...(forename && { forename }),
  });
  const searchUrl = `https://www.scotlandspeople.gov.uk/quick-people-search?${spParams}`;

  // Record-type specific links
  const recordLinks = {
    birth:    `https://www.scotlandspeople.gov.uk/guides/statutory-registers-births`,
    marriage: `https://www.scotlandspeople.gov.uk/guides/statutory-registers-marriages`,
    death:    `https://www.scotlandspeople.gov.uk/guides/statutory-registers-deaths`,
    census:   `https://www.scotlandspeople.gov.uk/guides/census-records`,
  };

  return json({
    source:      'scotlandspeople',
    coverage:    'Scotland — births, marriages, deaths, census, parish records',
    available:   false,
    reason:      'ScotlandsPeople does not support automated access. The index search is free but requires an interactive browser session.',
    search_url:  searchUrl,
    record_info: type ? (recordLinks[type] || null) : null,
    note:        'Index searching is free. Viewing images requires a paid subscription or pay-per-view credits.',
  });
}

// ============================================================
// SEARCH — ALL SOURCES (parallel)
// Runs CWGC + FreeBMD + FreeCen concurrently
// Adds Scotland deep-link as a static key
// ============================================================
async function searchAll(url, env) {
  const surname  = url.searchParams.get('surname')  || '';
  const forename = url.searchParams.get('forename') || '';

  if (!surname) return json({ error: 'surname is required' }, 400);

  // Run live sources in parallel
  const [cwgcSettled, bmdSettled, censusSettled] = await Promise.allSettled([
    searchCWGC(url, env),
    searchBMD(url, env),
    searchCensus(url, env),
  ]);

  const cwgc = cwgcSettled.status === 'fulfilled'
    ? await cwgcSettled.value.json()
    : { results: [], error: 'CWGC unavailable' };

  const bmd = bmdSettled.status === 'fulfilled'
    ? await bmdSettled.value.json()
    : { results: [], error: 'FreeBMD unavailable' };

  const census = censusSettled.status === 'fulfilled'
    ? await censusSettled.value.json()
    : { results: [], error: 'FreeCen unavailable' };

  // Scotland — always a deep-link, no async needed
  const spParams = new URLSearchParams({
    surname,
    ...(forename && { forename }),
  });
  const scotland = {
    source:     'scotlandspeople',
    available:  false,
    reason:     'ScotlandsPeople does not support automated access.',
    search_url: `https://www.scotlandspeople.gov.uk/quick-people-search?${spParams}`,
    coverage:   'Scotland — births, marriages, deaths, census 1553–1955',
  };

  // Summary counts for the UI
  const totalLive =
    (cwgc.count    || cwgc.results?.length    || 0) +
    (bmd.count     || bmd.results?.length     || 0) +
    (census.count  || census.results?.length  || 0);

  return json({
    cwgc,
    bmd,
    census,
    scotland,
    meta: {
      surname,
      forename:    forename || null,
      total_live:  totalLive,
      sources:     ['cwgc', 'freebmd', 'freecen'],
      scotland:    'deep-link only',
      searched_at: new Date().toISOString(),
    },
  });
}

// ============================================================
// D1 CACHE HELPERS
// ============================================================
async function getCachedResults(env, cacheKey) {
  try {
    const row = await env.ROOTLINE_DB.prepare(
      'SELECT results_json, cached_at FROM scrape_cache WHERE cache_key = ?'
    ).bind(cacheKey).first();

    if (!row) return null;

    // Check TTL
    const cachedAt  = new Date(row.cached_at);
    const expiresAt = new Date(cachedAt.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > expiresAt) {
      // Expired — delete and return null
      await env.ROOTLINE_DB.prepare('DELETE FROM scrape_cache WHERE cache_key = ?').bind(cacheKey).run();
      return null;
    }

    return JSON.parse(row.results_json);
  } catch (e) {
    console.warn('Cache read failed:', e.message);
    return null;
  }
}

async function cacheResults(env, cacheKey, source, payload) {
  try {
    await env.ROOTLINE_DB.prepare(
      `INSERT OR REPLACE INTO scrape_cache (cache_key, source, results_json, cached_at)
       VALUES (?, ?, ?, ?)`
    ).bind(cacheKey, source, JSON.stringify(payload), new Date().toISOString()).run();
  } catch (e) {
    console.warn('Cache write failed:', e.message);
    // Non-critical — don't fail the search response
  }
}

// ============================================================
// TREE — KV-backed family tree (unchanged)
// ============================================================
async function getTree(env) {
  const indexRaw = await env.ROOTLINE_TREE.get('tree:index');
  const index    = indexRaw ? JSON.parse(indexRaw) : [];

  if (!index.length) return json({ persons: [], meta: {} });

  const entries = await Promise.all(
    index.map(id => env.ROOTLINE_TREE.get(`tree:person:${id}`))
  );

  const persons = entries.filter(Boolean).map(p => JSON.parse(p));

  const metaRaw = await env.ROOTLINE_TREE.get('tree:meta');
  const meta    = metaRaw ? JSON.parse(metaRaw) : {};

  return json({ persons, meta });
}

async function addPerson(request, env) {
  const body = await request.json();

  if (!body.surname || !body.forename) {
    return json({ error: 'surname and forename are required' }, 400);
  }

  if (body.born?.year && body.born.year > 1990) {
    return json({ error: 'We do not store data on potentially living persons (born after 1990).' }, 422);
  }

  const id = generateId();
  const person = {
    id,
    surname:   sanitise(body.surname),
    forename:  sanitise(body.forename),
    born:      body.born    || null,
    died:      body.died    || null,
    relation:  sanitise(body.relation || ''),
    gender:    body.gender  || null,
    parents:   [],
    children:  [],
    spouses:   [],
    records:   [],
    notes:     sanitise(body.notes   || ''),
    addedBy:   sanitise(body.addedBy || 'Family'),
    addedAt:   new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await env.ROOTLINE_TREE.put(`tree:person:${id}`, JSON.stringify(person));

  const indexRaw = await env.ROOTLINE_TREE.get('tree:index');
  const index    = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(id);
  await env.ROOTLINE_TREE.put('tree:index', JSON.stringify(index));

  const metaRaw = await env.ROOTLINE_TREE.get('tree:meta');
  if (!metaRaw) {
    await env.ROOTLINE_TREE.put('tree:meta', JSON.stringify({
      created: new Date().toISOString(),
      family:  person.surname,
    }));
  }

  return json({ person, created: true }, 201);
}

async function updatePerson(request, path, env) {
  const id   = path.replace('/api/tree/', '');
  const body = await request.json();

  const existing = await env.ROOTLINE_TREE.get(`tree:person:${id}`);
  if (!existing) return json({ error: 'Person not found' }, 404);

  const person  = JSON.parse(existing);
  const updated = {
    ...person,
    ...body,
    id:        person.id,
    addedAt:   person.addedAt,
    addedBy:   person.addedBy,
    updatedAt: new Date().toISOString(),
  };

  if (updated.born?.year && updated.born.year > 1990) {
    return json({ error: 'We do not store data on potentially living persons.' }, 422);
  }

  await env.ROOTLINE_TREE.put(`tree:person:${id}`, JSON.stringify(updated));
  return json({ person: updated });
}

async function deletePerson(path, env) {
  const id = path.replace('/api/tree/', '');

  const existing = await env.ROOTLINE_TREE.get(`tree:person:${id}`);
  if (!existing) return json({ error: 'Person not found' }, 404);

  await env.ROOTLINE_TREE.delete(`tree:person:${id}`);

  const indexRaw = await env.ROOTLINE_TREE.get('tree:index');
  const index    = indexRaw ? JSON.parse(indexRaw) : [];
  await env.ROOTLINE_TREE.put('tree:index', JSON.stringify(index.filter(i => i !== id)));

  return json({ deleted: true, id });
}

// ============================================================
// AI — Historical Context (unchanged)
// ============================================================
async function aiContext(request, env) {
  const body = await request.json();
  const { record, type } = body;
  if (!record) return json({ error: 'record is required' }, 400);

  let prompt = '';

  if (type === 'cwgc') {
    prompt = `A family history researcher has found this war record for a relative:

Name: ${record.forename} ${record.surname}
Rank: ${record.rank}
Regiment/Unit: ${record.regiment}
Date of death: ${record.died}
Age: ${record.age || 'unknown'}
Cemetery: ${record.cemetery}, ${record.cemetery_country}
Conflict: ${record.conflict}
Next of kin: ${record.next_of_kin || 'not recorded'}

Please provide rich historical context (300 words) covering:
1. What was happening militarily at the time and place of death
2. What life would have been like for someone of this rank/regiment
3. What the experience of the family receiving the news would have been like
4. What other records likely exist (pension records, medals, service records) and where to find them

Write warmly — this is someone's great-grandfather. Be specific and historically accurate.`;

  } else if (type === 'census') {
    const r = record;
    prompt = `A family history researcher found this census record for a relative:

Name: ${r.forename || ''} ${r.surname}
Census year: ${r.census_year}
Age at census: ${r.age || 'unknown'}
Birth year (approx): ${r.birth_year || 'unknown'}
Birth county: ${r.birth_county || 'unknown'}
Census district: ${r.district || 'unknown'}, ${r.county || ''}

Please provide historical context (250 words) covering:
1. What life was like in ${r.district || r.county || 'this area'} in ${r.census_year}
2. What this record tells us about the family's likely circumstances
3. What related records would exist (BMD registrations, other census years, parish registers)
4. Any relevant local history for this area and era

Write warmly and engagingly — bring this ancestor to life.`;

  } else {
    const r = record;
    prompt = `A family history researcher found this civil registration record for a relative:

Type: ${type || 'record'}
Name: ${r.forename || ''} ${r.surname}
Year: ${r.year}, Quarter: ${r.quarter || 'unknown'}
District: ${r.district}
${r.age_at_death   ? `Age at death: ${r.age_at_death}`         : ''}
${r.spouse_surname ? `Spouse surname: ${r.spouse_surname}`     : ''}
${r.mothers_maiden ? `Mother's maiden name: ${r.mothers_maiden}` : ''}

Please provide historical context (250 words) covering:
1. What life was like in ${r.district || 'this area'} at this time
2. What this record tells us about the family's likely circumstances (occupation, social class)
3. What related records would exist and where to find them (census years, parish registers, etc.)
4. Any relevant local history for this area and era

Write warmly and engagingly — bring this ancestor to life.`;
  }

  const aiResp = await callClaude(env, prompt, 600);
  return json({ context: aiResp });
}

// ============================================================
// AI — Full Person Narrative (unchanged)
// ============================================================
async function aiNarrative(request, env) {
  const body = await request.json();
  const { person, records } = body;

  if (!person) return json({ error: 'person is required' }, 400);

  const cached = await env.ROOTLINE_DB.prepare(
    'SELECT narrative, generated_at FROM narratives WHERE person_id = ?'
  ).bind(person.id).first();

  if (cached) {
    return json({ narrative: cached.narrative, cached: true, generated_at: cached.generated_at });
  }

  const recordsSummary = records?.length
    ? records.map(r => `- ${r.source?.toUpperCase()}: ${r.forename || ''} ${r.surname}, ${r.died || r.year || r.census_year || ''}, ${r.regiment || r.district || r.county || ''}`).join('\n')
    : 'No records linked yet.';

  const prompt = `Write a beautifully crafted, literary family history narrative for this ancestor.

Person:
Name: ${person.forename} ${person.surname}
Born: ${person.born?.year || 'unknown'} in ${person.born?.place || 'unknown'}
Died: ${person.died?.year || 'unknown'} in ${person.died?.place || 'unknown'}
Relation to family: ${person.relation || 'ancestor'}
Notes: ${person.notes || 'none'}

Linked records:
${recordsSummary}

Write approximately 400 words in rich, literary prose. Include:
- A vivid opening that places this person in their world
- The historical backdrop of their life (Sheffield/Yorkshire context where relevant)
- What their daily life would have been like given their era and place
- How they connect to the broader family story
- A moving, human closing

This will be read by their descendants. Make it feel like a chapter from a proper family history book. No bullet points — pure narrative prose.`;

  const narrative = await callClaude(env, prompt, 800);

  await env.ROOTLINE_DB.prepare(
    'INSERT OR REPLACE INTO narratives (person_id, narrative, generated_at) VALUES (?, ?, ?)'
  ).bind(person.id, narrative, new Date().toISOString()).run();

  return json({ narrative, cached: false, generated_at: new Date().toISOString() });
}

// ============================================================
// HELPERS
// ============================================================
async function callClaude(env, prompt, maxTokens = 600) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

async function logSearch(env, type, surname, county, yearFrom, yearTo, count) {
  try {
    await env.ROOTLINE_DB.prepare(
      `INSERT INTO search_log (record_type, surname, county, year_from, year_to, result_count, searched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(type, surname, county || null, yearFrom || null, yearTo || null, count, new Date().toISOString()).run();
  } catch (e) {
    console.warn('Search log failed:', e.message);
  }
}

function splitCSVLine(line) {
  const cols = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols;
}

function guessConflict(dateStr) {
  if (!dateStr) return 'Unknown';
  const parts = dateStr.split('/');
  const year  = parseInt(parts[2] || parts[0]);
  if (year >= 1914 && year <= 1921) return 'First World War';
  if (year >= 1939 && year <= 1947) return 'Second World War';
  return 'Unknown';
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 10);
}

function sanitise(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, 500);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
