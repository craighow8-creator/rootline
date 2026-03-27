-- ============================================================
-- ROOTLINE — D1 Database Schema
-- Cloudflare D1 (SQLite-compatible)
-- Run with: wrangler d1 execute rootline-db --file=schema.sql
-- ============================================================

-- ------------------------------------------------------------
-- FreeBMD: BIRTHS
-- England & Wales civil registration 1837–1983
-- Source: freebmd.org.uk bulk data download
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS births (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  surname     TEXT NOT NULL COLLATE NOCASE,
  forename    TEXT COLLATE NOCASE,
  mother_surname TEXT COLLATE NOCASE,  -- mother's maiden name (post-1911)
  district    TEXT,
  county      TEXT,
  year        INTEGER NOT NULL,
  quarter     INTEGER CHECK(quarter IN (1,2,3,4)),  -- 1=Mar, 2=Jun, 3=Sep, 4=Dec
  volume      TEXT,
  page        TEXT,
  source      TEXT DEFAULT 'freebmd'
);

CREATE INDEX IF NOT EXISTS idx_births_surname     ON births(surname);
CREATE INDEX IF NOT EXISTS idx_births_surname_year ON births(surname, year);
CREATE INDEX IF NOT EXISTS idx_births_year        ON births(year);
CREATE INDEX IF NOT EXISTS idx_births_district    ON births(district);
CREATE INDEX IF NOT EXISTS idx_births_county      ON births(county);

-- ------------------------------------------------------------
-- FreeBMD: MARRIAGES
-- Indexed under both parties' surnames
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marriages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  surname        TEXT NOT NULL COLLATE NOCASE,
  forename       TEXT COLLATE NOCASE,
  spouse_surname TEXT COLLATE NOCASE,
  district       TEXT,
  county         TEXT,
  year           INTEGER NOT NULL,
  quarter        INTEGER CHECK(quarter IN (1,2,3,4)),
  volume         TEXT,
  page           TEXT,
  source         TEXT DEFAULT 'freebmd'
);

CREATE INDEX IF NOT EXISTS idx_marriages_surname       ON marriages(surname);
CREATE INDEX IF NOT EXISTS idx_marriages_surname_year  ON marriages(surname, year);
CREATE INDEX IF NOT EXISTS idx_marriages_spouse        ON marriages(spouse_surname);
CREATE INDEX IF NOT EXISTS idx_marriages_year          ON marriages(year);
CREATE INDEX IF NOT EXISTS idx_marriages_district      ON marriages(district);

-- ------------------------------------------------------------
-- FreeBMD: DEATHS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deaths (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  surname     TEXT NOT NULL COLLATE NOCASE,
  forename    TEXT COLLATE NOCASE,
  age         INTEGER,                 -- age at death (not always present)
  district    TEXT,
  county      TEXT,
  year        INTEGER NOT NULL,
  quarter     INTEGER CHECK(quarter IN (1,2,3,4)),
  volume      TEXT,
  page        TEXT,
  source      TEXT DEFAULT 'freebmd'
);

CREATE INDEX IF NOT EXISTS idx_deaths_surname      ON deaths(surname);
CREATE INDEX IF NOT EXISTS idx_deaths_surname_year ON deaths(surname, year);
CREATE INDEX IF NOT EXISTS idx_deaths_year         ON deaths(year);
CREATE INDEX IF NOT EXISTS idx_deaths_district     ON deaths(district);

-- ------------------------------------------------------------
-- CACHED AI NARRATIVES
-- Store generated narratives so we don't re-call Claude
-- each time a family member visits a person's page
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS narratives (
  person_id   TEXT PRIMARY KEY,        -- matches KV person ID
  narrative   TEXT NOT NULL,
  generated_at TEXT NOT NULL,          -- ISO 8601
  model       TEXT DEFAULT 'claude-sonnet-4-20250514'
);

-- ------------------------------------------------------------
-- SEARCH LOG (optional analytics, privacy-safe)
-- No PII — just aggregate query patterns
-- Helps understand which surnames/counties are searched most
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT,                    -- birth/marriage/death/cwgc
  surname     TEXT,
  county      TEXT,
  year_from   INTEGER,
  year_to     INTEGER,
  result_count INTEGER,
  searched_at TEXT NOT NULL            -- ISO 8601
);

-- ------------------------------------------------------------
-- SAMPLE DATA — Sheffield/Yorkshire Howes for demo
-- Real-ish data to prove the app works before FreeBMD import
-- Based on publicly known Sheffield registration district patterns
-- ------------------------------------------------------------

INSERT OR IGNORE INTO births (surname, forename, district, county, year, quarter, volume, page) VALUES
  ('Howe', 'Thomas William', 'Sheffield', 'Yorkshire', 1891, 1, '9c', '234'),
  ('Howe', 'Arthur James',   'Sheffield', 'Yorkshire', 1888, 3, '9c', '198'),
  ('Howe', 'Edith Mary',     'Sheffield', 'Yorkshire', 1895, 2, '9c', '312'),
  ('Howe', 'Frederick',      'Ecclesall Bierlow', 'Yorkshire', 1883, 4, '9c', '145'),
  ('Howe', 'Harriet',        'Sheffield', 'Yorkshire', 1879, 1, '9c', '089'),
  ('Howe', 'George Henry',   'Rotherham',  'Yorkshire', 1886, 2, '9c', '267'),
  ('Howe', 'Alice',          'Sheffield', 'Yorkshire', 1900, 3, '9c', '401'),
  ('Howe', 'Ernest',         'Sheffield', 'Yorkshire', 1893, 4, '9c', '355');

INSERT OR IGNORE INTO marriages (surname, forename, spouse_surname, district, county, year, quarter, volume, page) VALUES
  ('Howe', 'Thomas William', 'Bradshaw',  'Sheffield', 1914, 2, '9c', '445'),
  ('Howe', 'Arthur James',   'Greaves',   'Sheffield', 1912, 1, '9c', '389'),
  ('Howe', 'Frederick',      'Longden',   'Sheffield', 1908, 3, '9c', '302'),
  ('Bradshaw', 'Florence',   'Howe',      'Sheffield', 1914, 2, '9c', '445'),
  ('Greaves',  'Mabel',      'Howe',      'Sheffield', 1912, 1, '9c', '389');

INSERT OR IGNORE INTO deaths (surname, forename, age, district, county, year, quarter, volume, page) VALUES
  ('Howe', 'Harriet',      68, 'Sheffield', 'Yorkshire', 1947, 2, '9c', '678'),
  ('Howe', 'Frederick',    71, 'Sheffield', 'Yorkshire', 1954, 4, '9c', '712'),
  ('Howe', 'George Henry', 55, 'Sheffield', 'Yorkshire', 1941, 1, '9c', '589');
