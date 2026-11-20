/** Return true when `href` points to a static-host route on this Pimote origin. */
export function isStaticReportUrl(href: string, origin: string): boolean {
  try {
    const base = new URL(origin);
    const target = new URL(href, base);
    return target.origin === base.origin && /^\/s\/[^/]+(?:\/|$)/.test(target.pathname);
  } catch {
    return false;
  }
}

/** Static reports use the current tab on mobile and a new tab elsewhere. */
export function shouldNavigateStaticReportInCurrentTab(href: string, mobile: boolean, origin: string): boolean {
  return mobile && isStaticReportUrl(href, origin);
}
