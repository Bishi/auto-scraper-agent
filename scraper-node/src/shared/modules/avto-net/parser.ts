import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import type { Listing } from "../../types.js";
import { SELECTORS } from "./selectors.js";

const MODULE_NAME = "avto-net";

export function parseListings(html: string, sourceUrl: string): Listing[] {
  const $ = cheerio.load(html);
  const listings: Listing[] = [];

  $(SELECTORS.listingRow).each((_index, el) => {
    const $el = $(el);

    // Find link to individual listing
    const linkEl = $el.find(SELECTORS.link).first();
    const href = linkEl.attr("href") ?? "";
    if (!href) return;

    // Extract source ID from URL: details.asp?id=12345 or details.asp?ID=12345
    const sourceIdMatch = href.match(/[iI][dD]=(\d+)/);
    if (!sourceIdMatch) return;

    const sourceId = sourceIdMatch[1]!;
    const title = $el.find(SELECTORS.title).first().text().trim();
    if (!title) return;

    // Try sale price first (AKCIJSKA CENA), then regular price
    const salePriceText = $el.find(SELECTORS.priceSale).first().text().trim();
    const regularPriceText = $el.find(SELECTORS.priceRegular).first().text().trim();
    const priceText = salePriceText || regularPriceText;
    const price = parsePrice(priceText);

    // Track original price if on sale
    const oldPriceText = $el.find(SELECTORS.priceOld).first().text().trim();
    const originalPrice = oldPriceText ? parsePrice(oldPriceText) : null;

    // Parse the data table inside GO-Results-Data as label→value pairs.
    // Label tds have "d-none" in their class (hidden on mobile); value tds don't.
    const dataContainer = $el.find(SELECTORS.dataContainer).first();
    const tableData: Record<string, string> = {};
    dataContainer.find("table tr").each((_i, row) => {
      const tds = $(row).find("td");
      const labelTd = tds.filter((_j, td) => /\bd-none\b/.test($(td).attr("class") ?? "")).first();
      const valueTd = tds.filter((_j, td) => !/\bd-none\b/.test($(td).attr("class") ?? "")).first();
      const label = labelTd.text().trim().toLowerCase().replace(/\s+/g, "");
      const value = valueTd.text().trim();
      if (label && value) tableData[label] = value;
    });

    // Known Slovenian labels: "1.registracija", "prevoženih", "gorivo", "menjalnik", "motor", "baterija"
    const metadata: Record<string, string | number | null> = {
      year: parseYear(tableData["1.registracija"] ?? null),
      mileage: parseMileageKm(tableData["prevoženih"] ?? null),
      fuel: tableData["gorivo"] ?? null,
      transmission: tableData["menjalnik"] ?? null,
      engine: tableData["motor"] ?? null,
      originalPrice: originalPrice,
      onSale: salePriceText ? 1 : 0,
      // Only include battery when present — omitting the key keeps non-EV contentHash unchanged.
      ...(tableData["baterija"] ? { battery: tableData["baterija"] } : {}),
    };

    // Normalize URL: remove relative path segments like "../"
    const cleanHref = href.replace(/^\.\.\//, "/").replace(/^\.\//, "/");
    const listingUrl = cleanHref.startsWith("http")
      ? cleanHref
      : `https://www.avto.net${cleanHref.startsWith("/") ? "" : "/"}${cleanHref}`;

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
 * Extract the 4-digit calendar year from avto.net's registration date string.
 * e.g. "1. registracija: 3/2021" → 2021, "2021" → 2021, null/empty → null
 */
function parseYear(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1]!, 10);
  // Sanity check: must be a plausible car year
  return year >= 1900 && year <= new Date().getFullYear() + 1 ? year : null;
}

/**
 * Parse avto.net mileage strings into integer kilometres.
 * e.g. "45.000 km" → 45000, "100 km" → 100, null/empty → null
 */
function parseMileageKm(raw: string | null): number | null {
  if (!raw) return null;
  // Remove " km" suffix and any whitespace, then strip European thousands-dots
  const cleaned = raw.replace(/km/gi, "").replace(/\s/g, "").replace(/\./g, "").replace(/,/g, "");
  if (!cleaned) return null;
  const km = parseInt(cleaned, 10);
  return isNaN(km) ? null : km;
}

function parsePrice(text: string): number | null {
  // Handle: "15.900 EUR", "15.900,00 EUR", "Po dogovoru", "Pokličite", empty
  if (!text || /dogovor|pokli/i.test(text)) return null;

  // Remove currency and whitespace, handle European number format
  const cleaned = text.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  // European format: 15.900,00 -> 15900.00 or 15.900 -> 15900
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
    // Could be 15.900 (thousands) or 15.90 (decimal)
    // If digits after last dot are exactly 3, it's thousands separator
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
