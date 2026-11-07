// Read-only diagnostics. Never emit tokens or provider response bodies.
const notice = message => console.log('::notice::' + message);
const domain = 'https://ezshop.lifestyle/';
try {
  const page = await fetch(domain, { signal: AbortSignal.timeout(15000) });
  const html = await page.text();
  const asset = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  const root = asset ? new URL(asset,domain).pathname.startsWith('/assets/') : false;
  notice(`DOMAIN_HTTPS_HTTP_${page.status}; ROOT_ASSETS_${root ? 'YES' : 'NO'}`);
} catch (error) {
  const code = String(error?.cause?.code || 'UNAVAILABLE').replace(/[^A-Z0-9_]/g, '');
  notice('DOMAIN_HTTPS_NETWORK_' + code);
}
try {
  if (!/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || '')) throw new Error();
  const response = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY + '/pages', {
    headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept:'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) { notice(`PAGES_CONFIG_HTTP_${response.status}`); }
  else {
    const config = await response.json();
    const state = String(config.https_certificate?.state || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
    notice(`PAGES_DOMAIN_MATCH_${config.cname === 'ezshop.lifestyle' ? 'YES' : 'NO'}; HTTPS_ENFORCED_${config.https_enforced === true ? 'YES':'NO'}; CERT_${state}`);
  }
} catch { notice('PAGES_CONFIG_UNAVAILABLE'); }
