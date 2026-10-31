/**
 * DNS-rebinding protection: requests must name an allowed Host. A rebinding attack needs a domain
 * name, so IP literals are always fine; so are `localhost`, `*.localhost` and Tailscale MagicDNS names
 * (`*.ts.net`). Anything else must be listed in server.yaml `http.allowed_hosts` / BOTLAB_ALLOWED_HOSTS
 * (exact name, or `.example.lan` for a domain and its subdomains).
 */

import net from 'net';

export function hostName(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  const colon = h.lastIndexOf(':');
  const name = colon >= 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
  return name.replace(/\.$/, '') || null;
}

export function isHostAllowed(hostHeader: string | undefined, extra: readonly string[]): boolean {
  const name = hostName(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.ts.net')) return true;
  return extra.some((raw) => {
    const e = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!e) return false;
    return e.startsWith('.') ? name === e.slice(1) || name.endsWith(e) : name === e;
  });
}
