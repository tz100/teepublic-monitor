#!/usr/bin/env node
/**
 * TeePublic IP Monitor
 * Uses Google site-search to find infringing TeePublic listings.
 *
 * Usage:
 *   node scraper.js
 *   node scraper.js --artists "Unwound,Duster"
 */

const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  artists: process.env.ARTISTS
    ? process.env.ARTISTS.split(',').map(a => a.trim())
    : ['Unwound', 'Duster'],

  outputDir: './results',
  headless: true,

  label: {
    name:    'The Numero Group LLC',
    agent:   '[Your Name]',
    email:   '[Your Email]',
    address: '2533 S. Troy St, Chicago, IL 60623',
    website: 'https://numerogroup.com/',
  },
};

// Build multiple Google search queries per artist
function buildQueries(artist) {
  const slug = encodeURIComponent(`"${artist}"`);
  return [
    `https://www.google.com/search?q=site:teepublic.com+${slug}&num=20`,
    `https://www.google.com/search?q=site:teepublic.com+${slug}+shirt&num=20`,
    `https://www.google.com/search?q=site:teepublic.com+${slug}+sticker&num=20`,
    `https://www.google.com/search?q=site:teepublic.com+${slug}+poster&num=20`,
    `https://www.google.com/search?q=site:teepublic.com+${slug}+band&num=20`,
  ];
}

// ─── SCRAPER ─────────────────────────────────────────────────────────────────

async function scrapeArtist(browser, artist) {
  const page = await browser.newPage();
  const findings = [];
  const seen = new Set();

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  console.log(`\n🔍 Scanning: ${artist}`);
  const queries = buildQueries(artist);

  for (const queryUrl of queries) {
    console.log(`   Searching: ${queryUrl}`);

    try {
      await page.goto(queryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const content = await page.content();
      if (content.includes('unusual traffic') || content.includes('captcha')) {
        console.warn('   ⚠ Google CAPTCHA detected — skipping this query');
        continue;
      }

      const links = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('a[href]').forEach(el => {
          let href = el.href || '';
          if (href.includes('/url?q=')) {
            href = decodeURIComponent(href.split('/url?q=')[1].split('&')[0]);
          }
          // TeePublic product pages
          if (href.includes('teepublic.com/') && !href.includes('teepublic.com/user') && !href.includes('teepublic.com/tag')) {
            const parent = el.closest('div[data-hveid], div.g, div.tF2Cxc') || el.parentElement;
            const titleEl = parent?.querySelector('h3') || el;
            const title = titleEl?.textContent?.trim() || '';
            results.push({ href, title });
          }
        });
        return results;
      });

      for (const { href, title } of links) {
        const cleanUrl = href.split('?')[0];
        if (seen.has(cleanUrl)) continue;
        // Skip non-product pages
        if (cleanUrl === 'https://www.teepublic.com/' || cleanUrl === 'https://teepublic.com/') continue;
        seen.add(cleanUrl);

        // Extract product type from URL path
        const typeMatch = cleanUrl.match(/teepublic\.com\/([^/]+)\//);
        const type = typeMatch ? typeMatch[1].replace(/-/g, ' ') : 'unknown';

        // Extract seller — TeePublic URLs don't always include seller so pull from title
        const sellerMatch = cleanUrl.match(/teepublic\.com\/user\/([^/]+)/);
        const seller = sellerMatch ? sellerMatch[1] : '';

        const artistLower = artist.toLowerCase();
        const inUrl = cleanUrl.toLowerCase().includes(artistLower.replace(/\s+/g, '-'))
                   || cleanUrl.toLowerCase().includes(artistLower.replace(/\s+/g, '+'));
        const inTitle = title.toLowerCase().includes(artistLower);
        if (!inUrl && !inTitle) continue;

        findings.push({
          artist,
          title:      title || '(no title)',
          seller,
          type,
          confidence: inUrl && inTitle ? 'High' : inUrl ? 'High' : 'Medium',
          url:        cleanUrl,
          dmcaNotes:  buildNote(artist, title, type),
          date:       new Date().toISOString().split('T')[0],
          status:     'Pending',
        });
      }

      console.log(`   Found ${links.length} result(s), ${findings.length} unique so far`);
      await page.waitForTimeout(3000);

    } catch (err) {
      console.warn(`   ⚠ Error: ${err.message}`);
    }
  }

  await page.close();
  console.log(`   ✓ Total for ${artist}: ${findings.length} listings`);
  return findings;
}

function buildNote(artist, title, type) {
  const t = (title || '').toLowerCase();
  const notes = [];
  if (t.includes('tour'))  notes.push('Claims to be tour merch');
  if (t.includes(artist.toLowerCase())) notes.push(`Band name "${artist}" in title`);
  if (type !== 'unknown')  notes.push(`Product: ${type}`);
  return notes.join(' — ') || `Unauthorized use of ${artist} IP`;
}

// ─── CSV EXPORT ──────────────────────────────────────────────────────────────

async function exportCSV(findings) {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const filePath = path.join(CONFIG.outputDir, `teepublic-findings-${date}.csv`);

  const writer = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'artist',     title: 'Artist' },
      { id: 'title',      title: 'Title' },
      { id: 'seller',     title: 'Seller' },
      { id: 'type',       title: 'Product Type' },
      { id: 'confidence', title: 'Confidence' },
      { id: 'url',        title: 'URL' },
      { id: 'dmcaNotes',  title: 'DMCA Notes' },
      { id: 'date',       title: 'Date Found' },
      { id: 'status',     title: 'Status' },
    ],
  });

  await writer.writeRecords(findings);
  console.log(`\n📄 CSV saved: ${filePath}`);
  return filePath;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎵 TeePublic IP Monitor');
  console.log(`   Artists: ${CONFIG.artists.join(', ')}`);

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const allFindings = [];

  for (const artist of CONFIG.artists) {
    const findings = await scrapeArtist(browser, artist);
    allFindings.push(...findings);
  }

  await browser.close();

  const high = allFindings.filter(f => f.confidence === 'High');
  console.log(`\n📊 Summary:`);
  console.log(`   Total found    : ${allFindings.length}`);
  console.log(`   High confidence: ${high.length}`);

  if (allFindings.length === 0) {
    await exportCSV([{
      artist: 'N/A', title: 'No listings found this week', seller: '',
      type: '', confidence: '', url: '', dmcaNotes: '', date: new Date().toISOString().split('T')[0], status: ''
    }]);
  } else {
    await exportCSV(allFindings);
  }

  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
