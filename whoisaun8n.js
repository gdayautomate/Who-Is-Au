// ==============================================================================
// n8n Code in JavaScript Node (Mode: "Run Once for All Items")
// Copy and paste EVERYTHING below directly into your n8n Code node.
// ==============================================================================

// OPTIONAL: If you run `node whois-server.js` locally with a tunnel (ngrok / Cloudflare),
// put your tunnel URL here to get the full reCAPTCHA-bypassed registry emails:
// Example: const WHOIS_BRIDGE_URL = 'https://your-tunnel-url.loca.lt/whois?domain=';
const WHOIS_BRIDGE_URL = '';

const items = $input.all();

for (const item of items) {
  const website = item.json.Website || item.json.website || item.json.domain || '';
  if (!website) continue;

  // Clean domain name (e.g. "https://gdaybroadcast.com.au/about" -> "gdaybroadcast.com.au")
  const domain = website
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  let companyName = '';
  let contactEmail = '';

  // --------------------------------------------------------------------------
  // Method A: Check Local/Cloud WHOIS Bridge Server (if configured)
  // --------------------------------------------------------------------------
  if (WHOIS_BRIDGE_URL) {
    try {
      const bridgeRes = await fetch(`${WHOIS_BRIDGE_URL}${domain}`);
      if (bridgeRes.ok) {
        const bridgeData = await bridgeRes.json();
        companyName = bridgeData['Registrant Contact Name'] || bridgeData['Registrant'] || '';
        contactEmail = bridgeData['Tech Contact Email'] || bridgeData['Registrant Contact Email'] || '';
        item.json.WHOIS_Source = bridgeData.source || 'bridge';
      }
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // Method B: Query official auDA RDAP Registry (Always works in cloud n8n)
  // --------------------------------------------------------------------------
  if (!companyName) {
    try {
      const rdapRes = await fetch(`https://rdap.cctld.au/rdap/domain/${domain}`);
      if (rdapRes.ok) {
        const rdapData = await rdapRes.json();

        if (Array.isArray(rdapData.auData_eligibility)) {
          const regEntry = rdapData.auData_eligibility.find(e => e.name === 'registrant name') ||
                           rdapData.auData_eligibility.find(e => e.name === 'eligibility name');
          if (regEntry && regEntry.value) {
            companyName = regEntry.value;
          }

          const idEntry = rdapData.auData_eligibility.find(e => e.name === 'registrant id') ||
                          rdapData.auData_eligibility.find(e => e.name === 'eligibility id');
          if (idEntry && idEntry.value) {
            item.json.Registrant_ID = idEntry.value;
          }

          const typeEntry = rdapData.auData_eligibility.find(e => e.name === 'eligibility type');
          if (typeEntry && typeEntry.value) {
            item.json.Eligibility_Type = typeEntry.value;
          }
        }
      }
    } catch (err) {
      item.json.rdap_error = err.message;
    }
  }

  // --------------------------------------------------------------------------
  // Method C: Scrape business website to extract contact email
  // --------------------------------------------------------------------------
  if (!contactEmail) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const siteRes = await fetch(`https://${domain}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      clearTimeout(timeout);

      if (siteRes.ok) {
        const html = await siteRes.text();

        // 1. Check for mailto: links
        const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
        if (mailtoMatch) {
          contactEmail = mailtoMatch[1];
        } else {
          // 2. Check general email regex
          const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          const cleanEmails = emailMatches.filter(e =>
            !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.webp') && !e.includes('sentry')
          );
          const domainClean = domain.replace(/^www\./, '');
          const domainMatch = cleanEmails.find(e => e.toLowerCase().includes(domainClean));
          contactEmail = domainMatch || cleanEmails[0] || '';
        }
      }
    } catch (_) {}
  }

  // Populate row fields for next Google Sheet node
  if (companyName) {
    item.json.Name = companyName;
  }
  if (contactEmail) {
    item.json.Email = contactEmail;
  }
}

return items;
