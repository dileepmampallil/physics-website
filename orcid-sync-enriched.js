/**
 * orcid-sync-enriched.js
 *
 * ORCID → DOI harvesting
 * Crossref → authoritative metadata + citation counts
 * Fallback → Crossref author search
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const levenshtein = require('levenshtein-edit-distance');

/* ---------------- CONFIG ---------------- */

const ORCID_ROOT = 'https://pub.orcid.org/v3.0';
const CROSSREF_ROOT = 'https://api.crossref.org/works';

const MAPPING_FILE = path.join(__dirname, 'mapping.json');
const DATA_FILE = path.join(__dirname, 'publications.json');
const BACKUP_SUFFIX = '.bak';

const ORCID_DELAY = 400;
const CROSSREF_DELAY = 200;
const MAX_TITLE_DISTANCE = 6;
const VERBOSE = true;

/* ---------------- UTILS ---------------- */

const log = (...a) => VERBOSE && console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(f){
  try { return JSON.parse(fs.readFileSync(f,'utf8')); }
  catch { return null; }
}

function writeJSON(f,o){
  fs.writeFileSync(f, JSON.stringify(o,null,2),'utf8');
}

function normalizeDOI(d){
  if(!d) return '';
  return d.replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').trim().toLowerCase();
}

function normalizeTitle(t){
  return (t||'')
    .replace(/[^a-z0-9 ]/gi,'')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

async function fetchJson(url){
  const r = await fetch(url,{
    headers:{
      'Accept':'application/json',
      'User-Agent':'IISER-PublicationsBot/1.0 (mailto:webmaster@iisertirupati.ac.in)'
    }
  });
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/* ---------------- ORCID ---------------- */

function extractDOI(ext){
  if(!Array.isArray(ext)) return '';
  for(const e of ext){
    const t = (e['external-id-type']||'').toLowerCase();
    if(t.includes('doi')){
      return normalizeDOI(
        e['external-id-value'] ||
        e['external-id-url']?.value || ''
      );
    }
  }
  return '';
}

async function fetchOrcidWorks(orcid){
  const url = `${ORCID_ROOT}/${orcid}/works`;
  const json = await fetchJson(url);
  const groups = json.group || [];
  const dois = new Set();

  for(const g of groups){
    for(const s of (g['work-summary'] || [])){
      const d = extractDOI(s?.['external-ids']?.['external-id']);
      if(d) dois.add(d);
    }
  }
  return Array.from(dois);
}

/* ---------------- CROSSREF ---------------- */

function extractYear(m){
  return (
    m['published-print']?.['date-parts']?.[0]?.[0] ||
    m['published-online']?.['date-parts']?.[0]?.[0] ||
    m.issued?.['date-parts']?.[0]?.[0] || ''
  );
}

async function fetchCrossrefByDOI(doi){
  const url = `${CROSSREF_ROOT}/${encodeURIComponent(doi)}`;
  const json = await fetchJson(url);
  const m = json.message || {};

  return {
    title: Array.isArray(m.title) ? m.title[0] : '',
    authors: (m.author||[])
      .map(a => `${a.given||''} ${a.family||''}`.trim())
      .filter(Boolean)
      .join(', '),
    year: extractYear(m),
    venue: Array.isArray(m['container-title']) ? m['container-title'][0] : '',
    doi: normalizeDOI(m.DOI),
    url: m.URL || `https://doi.org/${normalizeDOI(m.DOI)}`,
    citations: m['is-referenced-by-count'] || 0,
    source: 'CrossRef'
  };
}

async function fetchCrossrefByAuthor(author, rows=50){
  const url =
    `${CROSSREF_ROOT}?query.author=${encodeURIComponent(author)}` +
    `&rows=${rows}&sort=published&order=desc`;

  const json = await fetchJson(url);
  const items = json.message?.items || [];

  return items.map(m => ({
    title: Array.isArray(m.title) ? m.title[0] : '',
    authors: (m.author||[])
      .map(a => `${a.given||''} ${a.family||''}`.trim())
      .filter(Boolean)
      .join(', '),
    year: extractYear(m),
    venue: Array.isArray(m['container-title']) ? m['container-title'][0] : '',
    doi: normalizeDOI(m.DOI),
    url: m.URL,
    citations: m['is-referenced-by-count'] || 0,
    source: 'CrossRef-author'
  }));
}

/* ---------------- DEDUPE ---------------- */

function alreadyExists(list, cand){
  if(cand.doi){
    return list.some(p => normalizeDOI(p.doi) === normalizeDOI(cand.doi));
  }
  const nt = normalizeTitle(cand.title);
  return list.some(p =>
    levenshtein(nt, normalizeTitle(p.title)) <= MAX_TITLE_DISTANCE
  );
}

function merge(db, key, name, papers){
  db[key] ||= { name, papers: [] };
  let added = 0;
  for(const p of papers){
    if(!alreadyExists(db[key].papers, p)){
      db[key].papers.push(p);
      added++;
    }
  }
  return added;
}

/* ---------------- MAIN ---------------- */

(async function(){
  log('ORCID + Crossref sync started');

  const mapping = readJSON(MAPPING_FILE);
  if(!mapping) throw new Error('mapping.json missing');

  let db = readJSON(DATA_FILE) || {};
  let total = 0;

  for(const key of Object.keys(mapping)){
    const { name, orcid } = mapping[key];
    log(`\n${name}`);

    let papers = [];

    /* 1️⃣ ORCID → DOIs */
    if(orcid){
      try{
        const dois = await fetchOrcidWorks(orcid);
        for(const d of dois){
          await sleep(CROSSREF_DELAY);
          try{
            papers.push(await fetchCrossrefByDOI(d));
          } catch {}
        }
      } catch {}
    }

    /* 2️⃣ Fallback: Crossref author search */
    if(papers.length === 0){
      log(`  ORCID empty → Crossref author search`);
      try{
        papers = await fetchCrossrefByAuthor(name);
      } catch {}
    }

    const added = merge(db, key, name, papers);
    log(`  added ${added}`);
    total += added;

    await sleep(ORCID_DELAY);
  }

  if(fs.existsSync(DATA_FILE)){
    fs.copyFileSync(DATA_FILE, DATA_FILE + BACKUP_SUFFIX);
  }

  writeJSON(DATA_FILE, db);
  log(`\nDone. Total new entries: ${total}`);
})();
