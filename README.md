# Rootline — Family History App
## Deploy Guide for Craig

**Live URL:** `https://craighow8-creator.github.io/rootline`
**Worker URL:** `https://rootline-worker.YOUR-SUBDOMAIN.workers.dev`

---

## Overview

| File | Purpose |
|---|---|
| `index.html` | Frontend — goes on GitHub Pages |
| `worker.js` | Cloudflare Worker — API proxy + tree storage |
| `schema.sql` | D1 database schema + seed data |
| `import.js` | FreeBMD bulk data import script |

---

## Step 1 — Create the GitHub Repo

1. Go to github.com → New repository
2. Name it: `rootline`
3. Set to **Public** (required for free GitHub Pages)
4. Don't initialise with README (you already have files)

```bash
git init
git add .
git commit -m "Initial Rootline build"
git branch -M main
git remote add origin https://github.com/craighow8-creator/rootline.git
git push -u origin main
```

5. Go to repo Settings → Pages → Source: **main branch / root**
6. Your app is live at: `https://craighow8-creator.github.io/rootline`

---

## Step 2 — Create the Cloudflare D1 Database

```bash
# Install Wrangler if not already installed
npm install -g wrangler

# Login to your Cloudflare account
wrangler login

# Create the D1 database
wrangler d1 create rootline-db
```

Copy the database ID from the output. You'll need it in wrangler.toml.

```bash
# Run the schema (creates tables + loads Yorkshire Howe seed data)
wrangler d1 execute rootline-db --file=schema.sql
```

Verify it worked:
```bash
wrangler d1 execute rootline-db --command="SELECT COUNT(*) FROM births"
# Should return 8 (seed records)
```

---

## Step 3 — Create the KV Namespace (family tree storage)

```bash
wrangler kv:namespace create ROOTLINE_TREE
```

Copy the namespace ID from the output.

---

## Step 4 — Create wrangler.toml

Create a file called `wrangler.toml` in your worker folder:

```toml
name = "rootline-worker"
main = "worker.js"
compatibility_date = "2024-01-01"
account_id = "c41a226e2d0f7ae9050b6cab5caeae76"

[[kv_namespaces]]
binding = "ROOTLINE_TREE"
id = "PASTE_YOUR_KV_NAMESPACE_ID_HERE"

[[d1_databases]]
binding = "ROOTLINE_DB"
database_name = "rootline-db"
database_id = "PASTE_YOUR_D1_DATABASE_ID_HERE"
```

---

## Step 5 — Add Your Anthropic API Key

```bash
wrangler secret put ANTHROPIC_API_KEY
# Paste your Anthropic API key when prompted
```

Get your API key from: https://console.anthropic.com

---

## Step 6 — Deploy the Worker

```bash
wrangler deploy
```

The worker URL will be shown — something like:
`https://rootline-worker.craighow8.workers.dev`

---

## Step 7 — Update the Frontend with Worker URL

Open `index.html` and find this line near the bottom:

```javascript
const WORKER_URL = 'https://rootline-worker.YOUR-SUBDOMAIN.workers.dev';
```

Replace with your actual Worker URL:

```javascript
const WORKER_URL = 'https://rootline-worker.craighow8.workers.dev';
```

Then push to GitHub:
```bash
git add index.html
git commit -m "Add Worker URL"
git push
```

---

## Step 8 — Import FreeBMD Data (optional but recommended)

The app works immediately with seed data (8 Yorkshire Howe records).
To get the full FreeBMD dataset:

1. Visit: https://www.freebmd.org.uk/big_file.html
2. Read and agree to FreeBMD's terms of use
3. Download the CSV files for the record types you want
4. Put them in a `data/` folder
5. Install dependencies: `npm install csv-parse commander`
6. Run the import:

```bash
# Import Yorkshire births only (smaller, faster)
node import.js --type=births --county=Yorkshire --year-from=1837 --year-to=1930

# Or all types for Yorkshire
node import.js --type=all --county=Yorkshire

# Or everything (large — may take hours)
node import.js --type=all
```

The app will show a banner if FreeBMD data isn't imported yet — this disappears automatically once you run the import.

---

## Sharing with Family

Once deployed, just share the URL:
`https://craighow8-creator.github.io/rootline`

- Anyone can view and search records
- Anyone can add ancestors to the shared tree
- The tree is stored in Cloudflare KV — everyone sees the same data
- AI context and narrative features require the Worker to be deployed

---

## Costs

| Service | Cost |
|---|---|
| GitHub Pages | Free |
| Cloudflare Workers | Free (100,000 requests/day) |
| Cloudflare KV | Free (100,000 reads/day) |
| Cloudflare D1 | Free (5GB storage, 5M rows read/day) |
| Anthropic API | ~$0.003 per AI context request (very cheap) |

For a family app this will essentially cost £0/month. The only real cost is the Anthropic API calls for historical context and narratives — at a few pence each, you'd need hundreds of requests a day to spend anything meaningful.

---

## Adding Future Features

### FamilySearch Integration (v2)
FamilySearch requires OAuth. Register a free developer account at:
https://www.familysearch.org/developers/

Add to the Worker:
- `/api/search/familysearch` endpoint with OAuth token exchange
- Searches census records, IGI (International Genealogical Index), and more

### GEDCOM Export
Standard genealogy file format — readable by Ancestry, FamilyTreeMaker etc.
The tree data structure is designed to support this.

### Photo Upload
Cloudflare R2 (S3-compatible) — free 10GB storage.
Add a photo field to each person card.

### Push Notifications (PWA)
When a family member adds someone, notify others.
Requires a service worker and push subscription.

---

## Troubleshooting

**Search returns no results**
→ Check the Worker is deployed and WORKER_URL is correct in index.html
→ Check the D1 database has data: `wrangler d1 execute rootline-db --command="SELECT COUNT(*) FROM births"`

**"Worker not yet deployed" messages**
→ The app falls back to localStorage until the Worker is live — this is by design

**CWGC returns no results**
→ The CWGC API is rate-limited. Try a more specific search (forename + surname)
→ CWGC data covers WWI and WWII only — no results for civilians

**FreeBMD import is slow**
→ Normal — the dataset is large. Use --county=Yorkshire to import just one county first

---

## Architecture Notes for Future Sessions

- Account ID: `c41a226e2d0f7ae9050b6cab5caeae76`
- GitHub: `craighow8-creator`
- Worker name: `rootline-worker`
- KV binding: `ROOTLINE_TREE`
- D1 binding: `ROOTLINE_DB`
- D1 database name: `rootline-db`
- Seed data: 8 Yorkshire Howe records (births/marriages/deaths) + 3 deaths
- Privacy rule: no persons born after 1925 stored or displayed
