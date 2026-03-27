// ============================================================
// ROOTLINE — Cloudflare Worker
// rootline-worker/index.js
//
// Bindings required in wrangler.toml:
//   KV:  ROOTLINE_TREE
//   D1:  ROOTLINE_DB
//   Secrets: ANTHROPIC_API_KEY, CWGC_API_KEY (optional)
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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
      if (path === '/api/search/cwgc'      && method === 'GET')  return searchCWGC(url, env);
      if (path === '/api/search/bmd'       && method === 'GET')  return searchBMD(url, env);
      if (path === '/api/search/all'       && method === 'GET')  return searchAll(url, env);

      // Tree endpoints
      if (path === '/api/tree'             && method === 'GET')  return getTree(env);
      if (path === '/api/tree'             && method === 'POST') return addPerson(request, env);
      if (path.startsWith('/api/tree/')    && method === 'PUT')  return updatePerson(request, path, env);
      if (path.startsWith('/api/tree/')    && method === 'DELETE') return deletePerson(path, env);

      // AI endpoints
      if (path === '/api/ai/context'       && method === 'POST') return aiContext(request, env);
      if (path === '/api/ai/narrative'     && method === 'POST') return aiNarrative(request, env);

      // Health check
      if (path === '/api/health'           && method === 'GET')  return json({ status: 'ok', version: '1.0.0' });

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  }
};

// ============================================================
// SEARCH — CWGC
// Commonwealth War Graves Commission API
// 1.7 million WWI + WWII casualties
// ============================================================
async function searchCWGC(url, env) {
  const surname   = url.searchParams.get('surname')   || '';
  const forename  = url.searchParams.get('forename')  || '';
  const conflict  = url.searchParams.get('conflict')  || '';   // WW1 or WW2
  const regiment  = url.searchParams.get('regiment')  || '';

  if (!surname) return json({ error: 'surname is required' }, 400);

  // CWGC public API — no key required for basic searches
  const params = new URLSearchParams({
    surname,
    ...(forename && { forename }),
    ...(conflict && { conflict }),
    ...(regiment && { unit: regiment }),
    limit: '50',
  });

  const cwgcUrl = `https://api.cwgc.org/v2/casualties?${params}`;

  const resp = await fetch(cwgcUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Rootline-FamilyHistory/1.0',
    }
  });

  if (!resp.ok) {
    // Graceful fallback — return empty rather than error
    console.error('CWGC API error:', resp.status);
    return json({ results: [], source: 'cwgc', error: 'CWGC API unavailable', count: 0 });
  }

  const data = await resp.json();

  // Normalise CWGC response into our standard format
  const results = (data.casualties || data.results || []).map(c => ({
    id:           c.id || c.casualtyId,
    source:       'cwgc',
    surname:      c.surname || '',
    forename:     c.initials || c.forename || '',
    rank:         c.rank || '',
    regiment:     c.unit || c.regiment || '',
    nationality:  c.nationality || 'United Kingdom',
    conflict:     c.conflict || '',
    died:         c.dateOfDeath || '',
    age:          c.age || null,
    cemetery:     c.cemetery?.name || '',
    cemetery_country: c.cemetery?.country || '',
    grave_ref:    c.graveReference || '',
    next_of_kin:  c.nextOfKin || '',
    memorial:     c.additionalInfo || '',
    cwgc_url:     `https://www.cwgc.org/find-records/find-war-dead/casualty-details/${c.id}/`,
  }));

  // Log search (privacy-safe — no PII)
  await logSearch(env, 'cwgc', surname, null, null, null, results.length);

  return json({ results, source: 'cwgc', count: results.length });
}

// ============================================================
// SEARCH — FreeBMD (via D1)
// England & Wales births, marriages, deaths 1837–1983
// ============================================================
async function searchBMD(url, env) {
  const surname  = url.searchParams.get('surname')  || '';
  const forename = url.searchParams.get('forename') || '';
  const type     = url.searchParams.get('type')     || 'all';  // birth/marriage/death/all
  const yearFrom = parseInt(url.searchParams.get('year_from') || '1837');
  const yearTo   = parseInt(url.searchParams.get('year_to')   || '1983');
  const county   = url.searchParams.get('county')   || '';
  const district = url.searchParams.get('district') || '';

  if (!surname) return json({ error: 'surname is required' }, 400);

  const results = { births: [], marriages: [], deaths: [] };

  // Build base WHERE clause
  const buildWhere = (extra = '') => {
    const parts = ['surname = ?'];
    const params = [surname];

    if (forename) {
      parts.push("forename LIKE ?");
      params.push(forename + '%');
    }
    if (county) {
      parts.push("county LIKE ?");
      params.push('%' + county + '%');
    }
    if (district) {
      parts.push("district LIKE ?");
      params.push('%' + district + '%');
    }
    parts.push("year >= ? AND year <= ?");
    params.push(yearFrom, yearTo);

    if (extra) parts.push(extra);
    return { where: parts.join(' AND '), params };
  };

  // Query births
  if (type === 'all' || type === 'birth') {
    const { where, params } = buildWhere();
    const q = await env.ROOTLINE_DB.prepare(
      `SELECT *, 'birth' as record_type FROM births WHERE ${where} ORDER BY year, quarter LIMIT 100`
    ).bind(...params).all();
    results.births = q.results || [];
  }

  // Query marriages
  if (type === 'all' || type === 'marriage') {
    const { where, params } = buildWhere();
    const q = await env.ROOTLINE_DB.prepare(
      `SELECT *, 'marriage' as record_type FROM marriages WHERE ${where} ORDER BY year, quarter LIMIT 100`
    ).bind(...params).all();
    results.marriages = q.results || [];
  }

  // Query deaths
  if (type === 'all' || type === 'death') {
    const { where, params } = buildWhere();
    const q = await env.ROOTLINE_DB.prepare(
      `SELECT *, 'death' as record_type FROM deaths WHERE ${where} ORDER BY year, quarter LIMIT 100`
    ).bind(...params).all();
    results.deaths = q.results || [];
  }

  const total = results.births.length + results.marriages.length + results.deaths.length;

  // Privacy guard — never surface records of potentially living people
  const currentYear = new Date().getFullYear();
  const safeFilter = r => r.year <= (currentYear - 100);

  results.births    = results.births.filter(safeFilter);
  results.marriages = results.marriages.filter(safeFilter);
  results.deaths    = results.deaths.filter(safeFilter);

  await logSearch(env, 'bmd', surname, county, yearFrom, yearTo, total);

  // Check if FreeBMD data has been imported yet
  const hasData = await env.ROOTLINE_DB.prepare('SELECT COUNT(*) as n FROM births').first();
  const dataImported = hasData?.n > 10; // more than our seed data

  return json({
    results,
    source: 'freebmd',
    count: total,
    data_imported: dataImported,
    note: dataImported ? null : 'FreeBMD bulk data not yet imported. Showing sample data only. See README for import instructions.'
  });
}

// ============================================================
// SEARCH — ALL SOURCES (parallel)
// ============================================================
async function searchAll(url, env) {
  const [cwgcResp, bmdResp] = await Promise.allSettled([
    searchCWGC(url, env),
    searchBMD(url, env),
  ]);

  const cwgc = cwgcResp.status === 'fulfilled'
    ? await cwgcResp.value.json()
    : { results: [], error: 'CWGC unavailable' };

  const bmd = bmdResp.status === 'fulfilled'
    ? await bmdResp.value.json()
    : { results: {}, error: 'BMD unavailable' };

  return json({ cwgc, bmd });
}

// ============================================================
// TREE — KV-backed family tree
// ============================================================
async function getTree(env) {
  const indexRaw = await env.ROOTLINE_TREE.get('tree:index');
  const index    = indexRaw ? JSON.parse(indexRaw) : [];

  if (!index.length) return json({ persons: [], meta: {} });

  // Fetch all persons in parallel
  const entries = await Promise.all(
    index.map(id => env.ROOTLINE_TREE.get(`tree:person:${id}`))
  );

  const persons = entries
    .filter(Boolean)
    .map(p => JSON.parse(p));

  const metaRaw = await env.ROOTLINE_TREE.get('tree:meta');
  const meta    = metaRaw ? JSON.parse(metaRaw) : {};

  return json({ persons, meta });
}

async function addPerson(request, env) {
  const body = await request.json();

  // Validate
  if (!body.surname || !body.forename) {
    return json({ error: 'surname and forename are required' }, 400);
  }

  // Privacy guard — block living persons
  if (body.born?.year && body.born.year > 1925) {
    return json({ error: 'We do not store data on potentially living persons (born after 1925).' }, 422);
  }

  const id = generateId();
  const person = {
    id,
    surname:    sanitise(body.surname),
    forename:   sanitise(body.forename),
    born:       body.born   || null,   // { year, place }
    died:       body.died   || null,   // { year, place }
    relation:   sanitise(body.relation || ''),
    gender:     body.gender || null,
    parents:    [],
    children:   [],
    spouses:    [],
    records:    [],                    // linked record IDs
    notes:      sanitise(body.notes || ''),
    addedBy:    sanitise(body.addedBy || 'Family'),
    addedAt:    new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
  };

  // Save person
  await env.ROOTLINE_TREE.put(`tree:person:${id}`, JSON.stringify(person));

  // Update index
  const indexRaw = await env.ROOTLINE_TREE.get('tree:index');
  const index    = indexRaw ? JSON.parse(indexRaw) : [];
  index.push(id);
  await env.ROOTLINE_TREE.put('tree:index', JSON.stringify(index));

  // Init meta if first person
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

  const person = JSON.parse(existing);

  // Merge updates (never overwrite id, addedAt, addedBy)
  const updated = {
    ...person,
    ...body,
    id:        person.id,
    addedAt:   person.addedAt,
    addedBy:   person.addedBy,
    updatedAt: new Date().toISOString(),
  };

  // Privacy guard
  if (updated.born?.year && updated.born.year > 1925) {
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
// AI — Historical Context
// Contextualises a found record with historical depth
// ============================================================
async function aiContext(request, env) {
  const body = await request.json();

  // Accept either a CWGC record or a BMD record
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

  } else {
    const r = record;
    prompt = `A family history researcher found this civil registration record for a relative:

Type: ${type || 'record'}
Name: ${r.forename || ''} ${r.surname}
Year: ${r.year}, Quarter: Q${r.quarter} (${['Jan-Mar','Apr-Jun','Jul-Sep','Oct-Dec'][r.quarter-1]})
District: ${r.district}, ${r.county}
${r.age ? `Age: ${r.age}` : ''}
${r.spouse_surname ? `Spouse surname: ${r.spouse_surname}` : ''}

Please provide historical context (250 words) covering:
1. What life was like in ${r.district}, ${r.county} at this time
2. What this record tells us about the family's likely circumstances (occupation, social class)
3. What related records would exist and where to find them (census years, parish registers, etc.)
4. Any relevant local history for this area and era

Write warmly and engagingly — bring this ancestor to life.`;
  }

  const aiResp = await callClaude(env, prompt, 600);
  return json({ context: aiResp });
}

// ============================================================
// AI — Full Person Narrative
// Generates a literary family history piece for one person
// Cached in D1 to avoid re-generating on every visit
// ============================================================
async function aiNarrative(request, env) {
  const body = await request.json();
  const { person, records } = body;

  if (!person) return json({ error: 'person is required' }, 400);

  // Check cache first
  const cached = await env.ROOTLINE_DB.prepare(
    'SELECT narrative, generated_at FROM narratives WHERE person_id = ?'
  ).bind(person.id).first();

  if (cached) {
    return json({ narrative: cached.narrative, cached: true, generated_at: cached.generated_at });
  }

  const recordsSummary = records?.length
    ? records.map(r => `- ${r.source?.toUpperCase()}: ${r.forename || ''} ${r.surname}, ${r.died || r.year || ''}, ${r.regiment || r.district || ''}`).join('\n')
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

  // Cache it
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
    ).bind(type, surname, county, yearFrom, yearTo, count, new Date().toISOString()).run();
  } catch (e) {
    // Non-critical — don't fail a search because logging failed
    console.warn('Search log failed:', e.message);
  }
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
