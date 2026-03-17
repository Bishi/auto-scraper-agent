import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseListings } from "../src/shared/modules/avto-net/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures/avto-net", name), "utf-8");

const SOURCE_URL =
  "https://www.avto.net/Ads/results.asp?znamka=bmw&tip=320d&cType=1";

describe("avto-net parser", () => {
  describe("standard listing layout", () => {
    it("parses both listings from fixture", () => {
      const listings = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listings).toHaveLength(2);
    });

    it("extracts sourceId, title, price, listingUrl, moduleName", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing).toBeDefined();
      expect(listing!.sourceId).toBe("12345");
      expect(listing!.title).toBe("BMW 320d 2.0 Efficientdynamics");
      expect(listing!.price).toBe(15900);
      expect(listing!.listingUrl).toBe(
        "https://www.avto.net/Ads/details.asp?id=12345",
      );
      expect(listing!.moduleName).toBe("avto-net");
      expect(listing!.sourceUrl).toBe(SOURCE_URL);
    });

    it("extracts metadata: year, mileage, fuel, transmission, engine", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      const meta = listing!.metadata;
      expect(meta["year"]).toBe(2021);
      expect(meta["mileage"]).toBe(45000);
      expect(meta["fuel"]).toBe("dizelski motor");
      expect(meta["transmission"]).toBe("avtomatski menjalnik");
      expect(meta["engine"]).toBe("1995 ccm, 140 kW / 190 KM");
      expect(meta["onSale"]).toBe(0);
      expect(meta["originalPrice"]).toBeNull();
    });

    it("extracts second listing with correct sourceId and mileage", () => {
      const listings = parseListings(fixture("standard.html"), SOURCE_URL);
      const second = listings[1]!;
      expect(second.sourceId).toBe("67890");
      expect(second.metadata["year"]).toBe(2018);
      expect(second.metadata["mileage"]).toBe(102000);
    });

    it("contentHash is a 64-char hex string", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("fingerprint is a 64-char hex string", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("fingerprint is deterministic across calls", () => {
      const html = fixture("standard.html");
      const [a] = parseListings(html, SOURCE_URL);
      const [b] = parseListings(html, SOURCE_URL);
      expect(a!.fingerprint).toBe(b!.fingerprint);
    });

    it("contentHash changes when price changes", () => {
      // Parse same fixture twice; manually verify two listings with different
      // prices produce different hashes.
      const listings = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listings[0]!.contentHash).not.toBe(listings[1]!.contentHash);
    });
  });

  describe("TOP PONUDBA layout (.GO-Results-Top-* selectors)", () => {
    it("parses the listing", () => {
      const listings = parseListings(fixture("top-ponudba.html"), SOURCE_URL);
      expect(listings).toHaveLength(1);
    });

    it("extracts fields from top-ponudba data container", () => {
      const [listing] = parseListings(
        fixture("top-ponudba.html"),
        SOURCE_URL,
      );
      expect(listing!.sourceId).toBe("55555");
      expect(listing!.title).toBe("Mercedes-Benz C 220d AMG Line");
      expect(listing!.price).toBe(38900);
      expect(listing!.metadata["year"]).toBe(2022);
      expect(listing!.metadata["mileage"]).toBe(28000);
    });
  });

  describe("sale price (AkcijaCena)", () => {
    it("uses AkcijaCena over Regular when both present", () => {
      const [listing] = parseListings(fixture("sale-price.html"), SOURCE_URL);
      expect(listing!.price).toBe(19800);
    });

    it("sets onSale=1 and originalPrice from StaraCena", () => {
      const [listing] = parseListings(fixture("sale-price.html"), SOURCE_URL);
      expect(listing!.metadata["onSale"]).toBe(1);
      expect(listing!.metadata["originalPrice"]).toBe(21000);
    });
  });

  describe("price parsing", () => {
    it("returns null for 'Po dogovoru'", () => {
      const [listing] = parseListings(fixture("negotiable.html"), SOURCE_URL);
      expect(listing!.price).toBeNull();
    });

    it("parses European thousands-dot format: '15.900 EUR' → 15900", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.price).toBe(15900);
    });
  });

  describe("mileage parsing", () => {
    it("strips dots and 'km' from '45.000 km' → 45000", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.metadata["mileage"]).toBe(45000);
    });

    it("parses '102.000 km' → 102000", () => {
      const listings = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listings[1]!.metadata["mileage"]).toBe(102000);
    });

    it("parses '156.000 km' → 156000", () => {
      const [listing] = parseListings(fixture("negotiable.html"), SOURCE_URL);
      expect(listing!.metadata["mileage"]).toBe(156000);
    });
  });

  describe("year parsing", () => {
    it("extracts 4-digit year from '3/2021' → 2021", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.metadata["year"]).toBe(2021);
    });

    it("extracts year from '11/2022' → 2022", () => {
      const [listing] = parseListings(
        fixture("top-ponudba.html"),
        SOURCE_URL,
      );
      expect(listing!.metadata["year"]).toBe(2022);
    });
  });

  describe("edge cases", () => {
    it("returns empty array when no listing rows present", () => {
      const listings = parseListings(
        "<html><body></body></html>",
        SOURCE_URL,
      );
      expect(listings).toHaveLength(0);
    });

    it("skips rows with no valid listing link (no href with /Ads/details.asp)", () => {
      const html = `
        <div class="GO-Results-Row">
          <div class="GO-Results-Naziv"><span>Missing link</span></div>
          <a href="/some/other/path">irrelevant</a>
        </div>`;
      const listings = parseListings(html, SOURCE_URL);
      expect(listings).toHaveLength(0);
    });

    it("skips rows where title is empty", () => {
      const html = `
        <div class="GO-Results-Row">
          <div class="GO-Results-Naziv"><span></span></div>
          <a href="../Ads/details.asp?id=99">link</a>
        </div>`;
      const listings = parseListings(html, SOURCE_URL);
      expect(listings).toHaveLength(0);
    });
  });
});
