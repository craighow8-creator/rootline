CREATE TABLE IF NOT EXISTS births (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surname TEXT NOT NULL,
  forename TEXT,
  mother_surname TEXT,
  district TEXT,
  county TEXT,
  year INTEGER NOT NULL,
  quarter INTEGER,
  volume TEXT,
  page TEXT,
  source TEXT DEFAULT 'freebmd'
);

CREATE TABLE IF NOT EXISTS marriages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surname TEXT NOT NULL,
  forename TEXT,
  spouse_surname TEXT,
  district TEXT,
  county TEXT,
  year INTEGER NOT NULL,
  quarter INTEGER,
  volume TEXT,
  page TEXT,
  source TEXT DEFAULT 'freebmd'
);

CREATE TABLE IF NOT EXISTS deaths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surname TEXT NOT NULL,
  forename TEXT,
  age INTEGER,
  district TEXT,
  county TEXT,
  year INTEGER NOT NULL,
  quarter INTEGER,
  volume TEXT,
  page TEXT,
  source TEXT DEFAULT 'freebmd'
);

CREATE TABLE IF NOT EXISTS narratives (
  person_id TEXT PRIMARY KEY,
  narrative TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model TEXT DEFAULT 'claude-sonnet-4-20250514'
);

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT,
  surname TEXT,
  county TEXT,
  year_from INTEGER,
  year_to INTEGER,
  result_count INTEGER,
  searched_at TEXT NOT NULL
);

INSERT INTO births (surname, forename, mother_surname, district, county, year, quarter, volume, page) VALUES
  ('Howe', 'Thomas William', '', 'Sheffield', 'Yorkshire', 1891, 1, '9c', '234'),
  ('Howe', 'Arthur James', '', 'Sheffield', 'Yorkshire', 1888, 3, '9c', '198'),
  ('Howe', 'Edith Mary', '', 'Sheffield', 'Yorkshire', 1895, 2, '9c', '312'),
  ('Howe', 'Frederick', '', 'Ecclesall Bierlow', 'Yorkshire', 1883, 4, '9c', '145'),
  ('Howe', 'Harriet', '', 'Sheffield', 'Yorkshire', 1879, 1, '9c', '089'),
  ('Howe', 'George Henry', '', 'Rotherham', 'Yorkshire', 1886, 2, '9c', '267'),
  ('Howe', 'Alice', '', 'Sheffield', 'Yorkshire', 1900, 3, '9c', '401'),
  ('Howe', 'Ernest', '', 'Sheffield', 'Yorkshire', 1893, 4, '9c', '355');

INSERT INTO marriages (surname, forename, spouse_surname, district, county, year, quarter, volume, page) VALUES
  ('Howe', 'Thomas William', 'Bradshaw', 'Sheffield', 'Yorkshire', 1914, 2, '9c', '445'),
  ('Howe', 'Arthur James', 'Greaves', 'Sheffield', 'Yorkshire', 1912, 1, '9c', '389'),
  ('Howe', 'Frederick', 'Longden', 'Sheffield', 'Yorkshire', 1908, 3, '9c', '302'),
  ('Bradshaw', 'Florence', 'Howe', 'Sheffield', 'Yorkshire', 1914, 2, '9c', '445'),
  ('Greaves', 'Mabel', 'Howe', 'Sheffield', 'Yorkshire', 1912, 1, '9c', '389');

INSERT INTO deaths (surname, forename, age, district, county, year, quarter, volume, page) VALUES
  ('Howe', 'Harriet', 68, 'Sheffield', 'Yorkshire', 1947, 2, '9c', '678'),
  ('Howe', 'Frederick', 71, 'Sheffield', 'Yorkshire', 1954, 4, '9c', '712'),
  ('Howe', 'George Henry', 55, 'Sheffield', 'Yorkshire', 1941, 1, '9c', '589');
