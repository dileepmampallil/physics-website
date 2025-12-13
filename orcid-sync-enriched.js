/**
 * orcid-sync-enriched.js
 *
 * Fetch ORCID works for faculty listed in mapping.json, extract DOIs,
 * enrich metadata via CrossRef API where DOI exists, merge into publications.json.
 *
 * Usage:
 *   node orcid-sync-enriched.js
 *
 * Notes:
 * - npm install before running (node-fetch@2 and levenshtein-edit-distance).
 * - mapping.json must exist next to this script.
 * - publications.json will be created/updated in the same folder.
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

// configuration
const VERBOSE = true;
const DELAY_BETWEEN_ORCID_MS = 500;   // polite delay between ORCID calls
const DELAY_BETWEEN_CROSSREF_MS = 200; // polite delay between CrossRef calls
const MAX_TITLE_DISTANCE = 6; // used to dedupe non-doi entries (Levenshtein threshold)

// helpers
function log(...args){ if(VERBOSE) console.log(...args); }
function readJSON(filepath){ try { return JSON.parse(fs.readFileSync(filepath,'utf8')); } catch(e) { return null; } }
function writeJSON(filepath, obj){ fs.writeFileSync(filepath, JSON.stringify(obj, null, 2), 'utf8'); }

// normalize title for basic fuzzy matching
function normalizeTitle(t){
  if(!t) return '';
  return t.replace(/\s+/g,' ').replace(/[^a-zA-Z0-9 ]/g,'').trim().toLowerCase();
}

// safe DOI normalization
function normalizeDOI(d){
  if(!d) return '';
  return d.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').toLowerCase();
}

// fetch JSON with Accept header
async function fetchJson(url){
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'IISER-PubSync/1.0 (mailto:your-email@institute.edu)' }});
  if(!res.ok){
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text.slice(0,200)}`);
  }
  return await res.json();
}

// extract DOI from ORCID work-summary or work-detail structures, if present
function extractDoiFromOrcidSummary(summary){
  try{
    // ORCID has 'external-ids' => 'external-id' array
    const ext = summary['external-ids'] && summary['external-ids']['external-id'];
    if(Array.isArray(ext)){
      for(const e of ext){
        const type = (e['external-id-type'] || '').toLowerCase();
        if(type.includes('doi')){
          const val = e['external-id-value'] || '';
          const url = e['external-id-url']?.value || '';
          return normalizeDOI(val || url);
        }
      }
    }
    // sometimes summary.url or url.value contains DOI-like string
  } catch(e){}
  return '';
}

// transform ORCID work summary + (optional) detail into preliminary paper object
function transformOrcidWork(summary, detail){
  const title = (detail?.title?.title?.value) || (summary?.title?.title?.value) || '';
  const year = detail?.publication_date?.year?.value || summary?.publication_date?.year || '';
  const venue = detail?.journal_title || detail?.source?.sourceName || summary?.journal_title || '';
  let authors = '';
  if(detail && detail.contributors && Array.isArray(detail.contributors.contributor)){
    authors = detail.contributors.contributor.map(c => c['credit-name']?.value || c.contributor?.name || '').filter(Boolean).join(', ');
  } else if(summary && summary['display-name']) {
    authors = summary['display-name'];
  }
  const doi = detail && detail.external_identifiers ?
              (detail.external_identifiers.external_identifier || []).reduce((acc, id) => {
                const t = (id.external_identifier_type || '').toLowerCase();
                if(!acc && t.includes('doi')) return normalizeDOI(id.external_identifier_id?.value || id.external_identifier_url?.value || '');
                return acc;
              }, '') : extractDoiFromOrcidSummary(summary);

  const url = detail?.url?.value || summary?.path || '';

  return {
    id: summary['put-code'] ? `orcid_${summary['put-code']}` : `orcid_tmp_${Math.random().toString(36).slice(2,8)}`,
    title: title || '',
    authors: authors || '',
    year: year ? Number(year) : '',
    venue: venue || '',
    doi: doi || '',
    url: url || '',
    source: 'ORCID'
  };
}

// fetch works for a given ORCID id; returns array of preliminary paper objects (may contain doi)
async function fetchOrcidWorks(orcid){
  const url = `${ORCID_ROOT}/${orcid}/works`;
  const json = await fetchJson(url);
  const groups = json.group || [];
  const papers = [];
  for(const g of groups){
    const ws = g['work-summary'] || [];
    if(ws.length === 0) continue;
    const summary = ws[0];
    // optionally fetch detail? We'll try to fetch detail for better external identifiers if needed
    let detail = null;
    const putCode = summary['put-code'];
    if(putCode){
      try {
        // try fetching detail, but silently continue on failure
        const detailUrl = `${ORCID_ROOT}/${orcid}/work/${putCode}`;
        detail = await fetchJson(detailUrl);
        await sleep(DELAY_BETWEEN_ORCID_MS/2);
      } catch(err){
        // ignore detail fetch error but proceed with summary
      }
    }
    const paper = transformOrcidWork(summary, detail);
    papers.push(paper);
  }
  return papers;
}

// fetch CrossRef metadata for DOI; returns enriched paper object or null on failure
async function fetchCrossref(doi){
  doi = normalizeDOI(doi);
  if(!doi) return null;
  // CrossRef API URL encoding: encode DOI component
  const url = `${CROSSREF_ROOT}/${encodeURIComponent(doi)}`;
  try {
    const json = await fetchJson(url); // has 'message' with metadata
    const msg = json.message || {};
    const title = Array.isArray(msg.title) ? msg.title[0] : (msg.title || '');
    const authors = (msg.author || []).map(a => {
      const fam = a.family || ''; const giv = a.given || '';
      return (giv && fam) ? `${giv} ${fam}` : (a.name || fam || giv || '');
    }).filter(Boolean).join(', ');
    const year = (msg.published && msg.published['date-parts'] && msg.published['date-parts'][0] && msg.published['date-parts'][0][0]) ||
                 (msg['published-print'] && msg['published-print']['date-parts'] && msg['published-print']['date-parts'][0] && msg['published-print']['date-parts'][0][0]) ||
                 (msg['issued'] && msg['issued']['date-parts'] && msg['issued']['date-parts'][0] && msg['issued']['date-parts'][0][0]) || '';
    const venue = msg['container-title'] ? (Array.isArray(msg['container-title']) ? msg['container-title'][0] : msg['container-title']) : (msg.publisher || '');
    const urlOut = msg.URL || `https://doi.org/${doi}`;
    return {
      title: title || '',
      authors: authors || '',
      year: year ? Number(year) : '',
      venue: venue || '',
      doi: doi,
      url: urlOut
    };
  } catch(err){
    // CrossRef lookup failed - return null
    return null;
  }
}

// small sleep
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

// dedupe logic: use DOI if present; else fuzzy-match by normalized title
function alreadyExists(existingPapers, candidate){
  if(candidate.doi){
    const norm = normalizeDOI(candidate.doi);
    for(const p of existingPapers){
      if(p.doi && normalizeDOI(p.doi) === norm) return true;
    }
  } else if(candidate.title){
    const nt = normalizeTitle(candidate.title);
    for(const p of existingPapers){
      const pt = normalizeTitle(p.title || '');
      if(!pt) continue;
      const distance = levenshtein(nt, pt);
      if(distance <= MAX_TITLE_DISTANCE) return true;
    }
  }
  return false;
}

// merge enriched papers into publications dataset
function mergePapers(existing, facultyKey, facultyName, newPapers){
  existing[facultyKey] = existing[facultyKey] || { name: facultyName || facultyKey, papers: [] };
  const existingArr = existing[facultyKey].papers || [];
  let added = 0;
  for(const np of newPapers){
    if(!alreadyExists(existingArr, np)){
      existingArr.push(np);
      added++;
    }
  }
  existing[facultyKey].papers = existingArr;
  return added;
}

// main
(async function main(){
  log('Starting ORCID -> CrossRef enrichment sync...');

  // read mapping
  const mapping = readJSON(MAPPING_FILE);
  if(!mapping || Object.keys(mapping).length === 0){
    console.error('mapping.json missing or empty. Create mapping.json with facultyKey -> { name, orcid }');
    process.exit(1);
  }

  // read existing publications (or start empty)
  let existing = readJSON(DATA_FILE);
  if(!existing) { existing = {}; log('No existing publications.json found; starting with empty dataset.'); }

  let totalAdded = 0;
  for(const facultyKey of Object.keys(mapping)){
    const info = mapping[facultyKey];
    if(!info || !info.orcid){
      log(`Skipping ${facultyKey} — no ORCID in mapping.`);
      continue;
    }
    const orcid = info.orcid.trim();
    const fname = info.name || facultyKey;
    log(`\nProcessing ${facultyKey} (${fname}) ORCID=${orcid} ...`);
    try{
      const orcidPapers = await fetchOrcidWorks(orcid);
      log(`  found ${orcidPapers.length} works in ORCID summary for ${orcid}`);

      // For each ORCID paper: if DOI present -> fetch CrossRef to enrich
      const enriched = [];
      for(const op of orcidPapers){
        let final = Object.assign({}, op); // start with ORCID fields
        if(op.doi){
          try {
            await sleep(DELAY_BETWEEN_CROSSREF_MS);
            const cr = await fetchCrossrefSafe(op.doi);
            if(cr){
              final.title = cr.title || final.title;
              final.authors = cr.authors || final.authors;
              final.year = cr.year || final.year;
              final.venue = cr.venue || final.venue;
              final.url = cr.url || final.url || `https://doi.org/${normalizeDOI(op.doi)}`;
              final.doi = normalizeDOI(op.doi);
              final.source = 'CrossRef/ORCID';
            } else {
              final.doi = normalizeDOI(op.doi);
            }
          } catch(err){
            // on errors, keep ORCID data
            final.doi = normalizeDOI(op.doi);
          }
        } else {
          // no DOI: try to use ORCID-provided metadata as-is
        }
        enriched.push(final);
      }

      // Also try: if ORCID summary did not have DOI but detail has external identifiers (rare),
      // we already tried to fetch detail in transformOrcidWork (above).
      // Merge into existing dataset (dedupe)
      const added = mergePapers(existing, facultyKey, fname, enriched);
      log(`  merged ${enriched.length} works; added ${added} new entries for ${facultyKey}`);
      totalAdded += added;

      await sleep(DELAY_BETWEEN_ORCID_MS);
    } catch(err){
      console.error(`  ERROR processing ${facultyKey}: ${err.message}`);
    }
  }

  // backup old publications.json and write new
  try{
    if(fs.existsSync(DATA_FILE)){
      const bak = DATA_FILE + BACKUP_SUFFIX;
      fs.copyFileSync(DATA_FILE, bak);
      log(`Backup written to ${bak}`);
    }
    writeJSON(DATA_FILE, existing);
    log(`Sync complete. Total new entries added: ${totalAdded}. publications.json updated.`);
  } catch(err){
    console.error('Failed to write publications.json:', err.message);
  }
})();

// CrossRef safe wrapper with small retry
async function fetchCrossrefSafe(doi){
  try {
    const cr = await fetchCrossref(doi);
    return cr;
  } catch(err){
    // retry once after short wait
    await sleep(350);
    try { return await fetchCrossref(doi); } catch(e){ log(`CrossRef failed for ${doi}: ${e.message}`); return null; }
  }
}

// CrossRef fetch function returning {title, authors, year, venue, doi, url}
async function fetchCrossref(doi){
  doi = normalizeDOI(doi);
  if(!doi) throw new Error('empty doi');
  const url = `${CROSSREF_ROOT}/${encodeURIComponent(doi)}`;
  const json = await fetchJson(url);
  const msg = json.message || {};
  const title = Array.isArray(msg.title) ? msg.title[0] : (msg.title || '');
  const authors = (msg.author || []).map(a => {
    const fam = a.family || ''; const giv = a.given || '';
    return (giv && fam) ? `${giv} ${fam}` : (a.name || fam || giv || '');
  }).filter(Boolean).join(', ');
  const year = (msg['published-print'] && msg['published-print']['date-parts'] && msg['published-print']['date-parts'][0] && msg['published-print']['date-parts'][0][0]) ||
               (msg['published-online'] && msg['published-online']['date-parts'] && msg['published-online']['date-parts'][0] && msg['published-online']['date-parts'][0][0]) ||
               (msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0] && msg.issued['date-parts'][0][0]) || '';
  const venue = msg['container-title'] ? (Array.isArray(msg['container-title']) ? msg['container-title'][0] : msg['container-title']) : (msg.publisher || '');
  const urlOut = msg.URL || `https://doi.org/${doi}`;
  return { title, authors, year: year ? Number(year) : '', venue, doi, url: urlOut };
}
