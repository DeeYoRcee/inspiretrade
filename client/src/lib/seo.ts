/**
 * P69 SEO — runtime head management for the SPA.
 *
 * The whole app is a Vite SPA: every URL serves the same static index.html,
 * whose head carries the landing metadata (canonical "/" etc.). Googlebot
 * renders JavaScript, so public pages update the head per route here:
 *  - "/" landing (AuthPage gate) keeps the canonical landing metadata, so all
 *    gated app URLs consolidate to the homepage instead of becoming
 *    duplicate documents.
 *  - public profiles (/@handle) get a unique title/description and a
 *    self-canonical, so they are correct documents of their own.
 *
 * NOTE: values must stay in sync with client/index.html (the static defaults).
 */
const SITE = "https://inspiretrade.site";

export const SEO_DEFAULTS = {
  title: "InspireTrade - Everything about trading is here",
  description:
    "InspireTrade — everything is here: trading terminal, journal, analytics, news and rewards for forex & crypto traders",
  image: `${SITE}/logo.png`,
};

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.rel = "canonical";
    document.head.appendChild(el);
  }
  el.href = href;
}

export function applySeo(opts: { title?: string; description?: string; path: string }) {
  const title = opts.title ?? SEO_DEFAULTS.title;
  const description = opts.description ?? SEO_DEFAULTS.description;
  const url = `${SITE}${opts.path}`;

  document.title = title;
  upsertMeta("name", "description", description);
  upsertCanonical(url);
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", description);
  upsertMeta("property", "og:url", url);
  upsertMeta("property", "og:image", SEO_DEFAULTS.image);
  upsertMeta("name", "twitter:title", title);
  upsertMeta("name", "twitter:description", description);
  upsertMeta("name", "twitter:image", SEO_DEFAULTS.image);
}
