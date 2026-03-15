import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { Listing } from "../../types.js";
import { SELECTORS } from "./selectors.js";

const MODULE_NAME = "proteini-si";

export function parseProduct(html: string, url: string): Listing | null {
  const $ = cheerio.load(html);

  const title = $(SELECTORS.title).first().text().trim();
  if (!title) return null;

  const priceText = $(SELECTORS.price).first().text().trim();
  const price = parsePrice(priceText);

  const availContent = $(SELECTORS.availability).attr("content") ?? "";
  const inStock: 0 | 1 = availContent === "Na zalogi" ? 1 : 0;

  // sourceId = last non-empty path segment of the URL
  const urlObj = new URL(url);
  const sourceId =
    urlObj.pathname
      .split("/")
      .filter(Boolean)
      .pop() ?? urlObj.pathname;

  const metadata: Record<string, string | number | boolean | null> = {
    inStock,
    availability: availContent || null,
  };

  const contentHash = computeHash(title, price, inStock);
  const now = new Date().toISOString();

  return {
    sourceId,
    moduleName: MODULE_NAME,
    sourceUrl: url,
    listingUrl: url,
    title,
    price,
    metadata,
    contentHash,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function parsePrice(text: string): number | null {
  if (!text) return null;
  // "32,99 €" → strip non-digit/comma, then comma → dot
  const cleaned = text.replace(/[^\d,]/g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function computeHash(title: string, price: number | null, inStock: 0 | 1): string {
  const payload = `${title}|${price}|${inStock}`;
  return createHash("sha256").update(payload).digest("hex");
}
