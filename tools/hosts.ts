// Hostname checks with nothing from Node, so the page (web/src/analytics.ts) imports them too. tools/urls.ts, which
// uses node:crypto for long url keys, re-exports hostIs for the server.

/** Whether a hostname is the domain itself or one of its subdomains (never "evil-linkedin.com"). */
export const hostIs = (host: string | null | undefined, domain: string) => {
  const h = String(host ?? '').toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
};
