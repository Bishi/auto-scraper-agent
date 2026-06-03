import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { Listing } from "../../types.js";
import { SELECTORS } from "./selectors.js";

const MODULE_NAME = "bolha";

export function parseListings(html: string, sourceUrl: string): Listing[] {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];

  $(SELECTORS.listingItem).each((_index, el) => {
    const $el = $(el);

    // Title + link from the entity-title anchor
    const titleLink = $el.find(SELECTORS.title).first();
    const title = titleLink.text().trim();
    if (!title) return;

    // Source ID: prefer the "name" attribute on the title link (clean numeric ID)
    const nameAttr = titleLink.attr("name") ?? "";
    const href = titleLink.attr("href") ?? titleLink.attr("data-href") ?? "";
    if (!href) return;

    const sourceId = nameAttr || extractSourceId(href);
    if (!sourceId) return;

    // Price from .price-item .price
    const priceText = $el.find(SELECTORS.price).first().text().trim();
    const price = parsePrice(priceText);

    // Location from entity-description
    const descriptionEl = $el.find(SELECTORS.description).first();
    const location = descriptionEl.text().replace(/Lokacija:\s*/i, "").trim() || null;

    // Publication date from time[datetime]
    const pubDateEl = $el.find(SELECTORS.pubDate).first();
    const pubDate = pubDateEl.attr("datetime") ?? null;

    // Image URL
    const imageEl = $el.find(SELECTORS.image).first();
    const imageUrl = imageEl.attr("src") ?? imageEl.attr("data-src") ?? null;

    const listingUrl = href.startsWith("http")
      ? href
      : `https://www.bolha.com${href.startsWith("/") ? "" : "/"}${href}`;

    const metadata: Record<string, string | number | boolean | null> = {
      location,
      pubDate,
      imageUrl,
    };

    const contentHash = computeHash(title, price, metadata);
    const now = new Date().toISOString();

    listings.push({
      sourceId,
      moduleName: MODULE_NAME,
      sourceUrl,
      listingUrl,
      title,
      price,
      metadata,
      contentHash,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  });

  return listings;
}

/**
 * Extract pagination page URLs from HTML.
 * Returns unique page URLs found in the pagination element.
 */
export function parsePaginationLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links = new Set<string>();

  $(SELECTORS.pagination).each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const fullUrl = href.startsWith("http")
      ? href
      : `https://www.bolha.com${href.startsWith("/") ? "" : "/"}${href}`;
    if (fullUrl !== baseUrl) {
      links.add(fullUrl);
    }
  });

  return [...links];
}

/**
 * Extract numeric source ID from bolha.com listing URL.
 * URL format: /category/slug-text-oglas-15574910
 * The ID is the number after the last "-oglas-" or just trailing digits.
 */
function extractSourceId(href: string): string | null {
  // Try: -oglas-12345678
  const oglasMatch = href.match(/-oglas-(\d+)/);
  if (oglasMatch) return oglasMatch[1] ?? null;

  // Fallback: last numeric segment in path
  const match = href.match(/\/(\d{5,})(?:[/?#]|$)/);
  if (match) return match[1] ?? null;

  return null;
}

function parsePrice(text: string): number | null {
  if (!text || /dogovor|pokli[čc]/i.test(text)) return null;

  // Remove currency symbols and whitespace
  const cleaned = text.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  let normalized: string;
  if (hasComma && hasDot) {
    // 15.900,00 format (dot = thousands, comma = decimal)
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // 15900,00 format (comma = decimal)
    normalized = cleaned.replace(",", ".");
  } else if (hasDot) {
    const parts = cleaned.split(".");
    const lastPart = parts[parts.length - 1]!;
    if (lastPart.length === 3 && parts.length > 1) {
      normalized = cleaned.replace(/\./g, "");
    } else {
      normalized = cleaned;
    }
  } else {
    normalized = cleaned;
  }

  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

function computeHash(
  title: string,
  price: number | null,
  metadata: Record<string, unknown>,
): string {
  const sortedKeys = Object.keys(metadata).sort();
  const sortedMeta: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedMeta[key] = metadata[key];
  }
  const payload = `${title}|${price}|${JSON.stringify(sortedMeta)}`;
  return createHash("sha256").update(payload).digest("hex");
}
