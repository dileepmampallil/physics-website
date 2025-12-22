/**
 * orcid-sync-enriched.js (CLEAN FIXED VERSION)
 *
 * Fetch ORCID works for faculty listed in mapping.json,
 * enrich via CrossRef (if DOI exists),
 * and merge into publications.json.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const levenshtein = require('levenshtein-edit-distance');

const ORCID_ROOT = 'https://pub.orcid.org/v3.0';
const CROSSREF_ROOT = 'https://api.crossref.org/works';

const MAPPING_FILE = path.join(__dirname, 'mapping.json');
const DATA_FILE = path.join(__dirname, 'publications.json');
const BACKUP_SUFFIX = '.bak';

// config
const VERBOSE = true;
const ORCID_DELAY = 500;
const CROSSREF_DELAY = 200;
const MAX_TITLE_DISTANCE = 6;

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
      'User-Agent':'IISER-PubSync/1.0 (mailto:admin@iisertirupati.ac.in)'
    }
  });
  if(!r.ok){
    throw new Error(`${r.status} ${r.statusText}`);
  }
  return r.json();
}

/* ---------- ORCID helpers ---------- */

function extractDOIFromExternalIds(ext){
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

function transformOrcidWork(summary, detail){
  const title =
    detail?.title?.title?.value ||
    summary?.title?.title?.value || '';

  const year =
    detail?.publication_date?.year?.value ||
    summary?.publication_date?.year?.value || '';

  const venue =
    detail?.journal_title?.value ||
    summary?.journal_title?.value || '';

  let authors = '';
  if(detail?.contributors?.contributor){
    authors = detail.contributors.contributor
      .map(c => c['credit-name']?.value)
      .filter(Boolean)
      .join(', ');
  }

  const doi =
    extractDOIFromExternalIds(
      detail?.external_identifiers?.external_identifier
    ) ||
    extractDOIFromExternalIds(
      summary?.['external-ids']?.['external-id']
    );

  return {
    id: `orcid_${summary['put-code']}`,
    title,
    authors,
    year: year ? Number(year) : '',
    venue,
    doi,
    url: detail?.url?.value || '',
    source: 'ORCID'
  };
}

async function fetchOrcidWorks(orcid){
  const url = `${ORCID_ROOT}/${orcid}/works`;
  const json = await fetchJson(url);
  const groups = json.group || [];
  const papers = [];

  for(const g of groups){
    const summaries = g['work-summary'] || [];
    for(const summary of summaries){
      let detail = null;
      if(summary['put-code']){
        try{
          detail = await fetchJson(
            `${ORCID_ROOT}/${orcid}/work/${summary['put-code']}`
          );
          await sleep(ORCID_DELAY/2);
        } catch {}
      }
      papers.push(transformOrcidWork(summary, detail));
    }
  }
  return papers;
}

/* ---------- CrossRef ---------- */

async function fetchCrossref(doi){
  doi = normalizeDOI(doi);
  if(!doi) return null;

  const url = `${CROSSREF_ROOT}/${encodeURIComponent(doi)}`;
  const json = await fetchJson(url);
  const m = json.message || {};

  const year =
    m['published-print']?.['date-parts']?.[0]?.[0] ||
    m['published-online']?.['date-parts']?.[0]?.[0] ||
    m['issued']?.['date-parts']?.[0]?.[0] || '';

  return {
    title: Array.isArray(m.title) ? m.title[0] : '',
    authors: (m.author||[])
      .map(a => `${a.given||''} ${a.family||''}`.trim())
      .filter(Boolean)
      .join(', '),
    year: year ? Number(year) : '',
    venue: Array.isArray(m['container-title']) ? m['container-title'][0] : '',
    doi,
    url: m.URL || `https://doi.org/${doi}`,
    source: 'CrossRef'
  };
}

/* ---------- Merge & dedupe ---------- */

function alreadyExists(list, cand){
  if(cand.doi){
    return list.some(p => normalizeDOI(p.doi) === normalizeDOI(cand.doi));
  }
  const nt = normalizeTitle(cand.title);
  return list.some(p =>
    levenshtein(nt, normalizeTitle(p.title)) <= MAX_TITLE_DISTANCE
  );
}

function merge(existing, key, name, papers){
  existing[key] ||= { name, papers: [] };
  let added = 0;

  for(const p of papers){
    if(!alreadyExists(existing[key].papers, p)){
      existing[key].papers.push(p);
      added++;
    }
  }
  return added;
}

/* ---------- Main ---------- */

(async function(){
  log('Starting ORCID sync...');
  const mapping = readJSON(MAPPING_FILE);
  if(!mapping) throw new Error('mapping.json missing');

  let db = readJSON(DATA_FILE) || {};
  let total = 0;

  for(const key of Object.keys(mapping)){
    const { name, orcid } = mapping[key];
    if(!orcid) continue;

    log(`\n${name} (${orcid})`);
    const works = await fetchOrcidWorks(orcid);

    const enriched = [];
    for(const w of works){
      let out = { ...w };
      if(w.doi){
        await sleep(CROSSREF_DELAY);
        try{
          const cr = await fetchCrossref(w.doi);
          if(cr){
            out = { ...out, ...cr };
          }
        } catch {}
      }
      enriched.push(out);
    }

    const added = merge(db, key, name, enriched);
    log(`  found ${works.length}, added ${added}`);
    total += added;

    await sleep(ORCID_DELAY);
  }

  if(fs.existsSync(DATA_FILE)){
    fs.copyFileSync(DATA_FILE, DATA_FILE + BACKUP_SUFFIX);
  }

  writeJSON(DATA_FILE, db);
  log(`\nDone. Total new entries: ${total}`);
})();
