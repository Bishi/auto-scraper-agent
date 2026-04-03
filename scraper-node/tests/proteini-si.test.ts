import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProduct } from "../src/shared/modules/proteini-si/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures/proteini-si", name), "utf-8");

const PRODUCT_URL =
  "https://www.proteini.si/proteini/impact-whey-protein-cokolada-1kg/";

describe("proteini-si parser", () => {
  describe("in-stock product", () => {
    it("parses title, price and availability", () => {
      const listing = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      expect(listing).not.toBeNull();
      expect(listing!.title).toBe("Impact Whey Protein - Čokolada 1 kg");
      expect(listing!.price).toBe(32.99);
      expect(listing!.metadata["inStock"]).toBe(1);
      expect(listing!.metadata["availability"]).toBe("Na zalogi");
    });

    it("derives sourceId from last URL path segment", () => {
      const listing = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      expect(listing!.sourceId).toBe("impact-whey-protein-cokolada-1kg");
    });

    it("sets sourceUrl and listingUrl to the provided URL", () => {
      const listing = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      expect(listing!.sourceUrl).toBe(PRODUCT_URL);
      expect(listing!.listingUrl).toBe(PRODUCT_URL);
    });

    it("sets moduleName to 'proteini-si'", () => {
      const listing = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      expect(listing!.moduleName).toBe("proteini-si");
    });

    it("contentHash is a 64-char hex string", () => {
      const listing = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      expect(listing!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("contentHash is deterministic", () => {
      const html = fixture("in-stock.html");
      const a = parseProduct(html, PRODUCT_URL);
      const b = parseProduct(html, PRODUCT_URL);
      expect(a!.contentHash).toBe(b!.contentHash);
    });
  });

  describe("out-of-stock product", () => {
    const OUT_URL =
      "https://www.proteini.si/kreatin/creatine-monohydrate-500g/";

    it("sets inStock=0 and availability when not 'Na zalogi'", () => {
      const listing = parseProduct(fixture("out-of-stock.html"), OUT_URL);
      expect(listing!.metadata["inStock"]).toBe(0);
      expect(listing!.metadata["availability"]).toBe("Ni na zalogi");
    });

    it("derives sourceId from last URL path segment", () => {
      const listing = parseProduct(fixture("out-of-stock.html"), OUT_URL);
      expect(listing!.sourceId).toBe("creatine-monohydrate-500g");
    });

    it("contentHash differs from in-stock product", () => {
      const inStock = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      const outOfStock = parseProduct(fixture("out-of-stock.html"), OUT_URL);
      expect(inStock!.contentHash).not.toBe(outOfStock!.contentHash);
    });
  });

  describe("discontinued product", () => {
    it("prefers visible discontinued text over the meta availability tag", () => {
      const html = `<html><body>
        <h1 class="h1-title">Snickers Hi Protein Powder</h1>
        <div class="price-holder">
          <span class="price">39,99 €</span>
        </div>
        <div class="notice">Izdelek ni več v prodaji</div>
        <meta itemprop="availability" content="Na zalogi">
      </body></html>`;

      const listing = parseProduct(
        html,
        "https://www.proteini.si/sl/products/snickers-hi-protein-powder-480g",
      );

      expect(listing).not.toBeNull();
      expect(listing!.metadata["inStock"]).toBe(0);
      expect(listing!.metadata["availability"]).toBe("Izdelek ni več v prodaji");
      expect(listing!.sourceId).toBe("snickers-hi-protein-powder-480g");
    });
  });

  describe("price parsing", () => {
    it("parses '32,99 €' → 32.99 (comma decimal, euro symbol)", () => {
      const listing = parseProduct(fixture("in-stock.html"), PRODUCT_URL);
      expect(listing!.price).toBe(32.99);
    });

    it("parses '14,99 €' → 14.99", () => {
      const listing = parseProduct(
        fixture("out-of-stock.html"),
        "https://www.proteini.si/kreatin/creatine-monohydrate-500g/",
      );
      expect(listing!.price).toBe(14.99);
    });
  });

  describe("edge cases", () => {
    it("returns null when title element is missing", () => {
      const html = `<html><body>
        <div class="price-holder"><span class="price">10,00 €</span></div>
        <meta itemprop="availability" content="Na zalogi">
      </body></html>`;
      const listing = parseProduct(html, PRODUCT_URL);
      expect(listing).toBeNull();
    });

    it("returns null price when price element is missing", () => {
      const html = `<html><body>
        <h1 class="h1-title">Some Product</h1>
        <meta itemprop="availability" content="Na zalogi">
      </body></html>`;
      const listing = parseProduct(html, PRODUCT_URL);
      expect(listing).not.toBeNull();
      expect(listing!.price).toBeNull();
    });

    it("sets inStock=0 when availability meta is absent", () => {
      const html = `<html><body>
        <h1 class="h1-title">Some Product</h1>
        <div class="price-holder"><span class="price">9,99 €</span></div>
      </body></html>`;
      const listing = parseProduct(html, PRODUCT_URL);
      expect(listing!.metadata["inStock"]).toBe(0);
      expect(listing!.metadata["availability"]).toBeNull();
    });

    it("does not mislabel ordinary out-of-stock text as discontinued", () => {
      const html = `<html><body>
        <h1 class="h1-title">Some Product</h1>
        <div class="price-holder"><span class="price">9,99 €</span></div>
        <div>Ni na zalogi</div>
        <meta itemprop="availability" content="Ni na zalogi">
      </body></html>`;
      const listing = parseProduct(html, PRODUCT_URL);
      expect(listing).not.toBeNull();
      expect(listing!.metadata["inStock"]).toBe(0);
      expect(listing!.metadata["availability"]).toBe("Ni na zalogi");
    });
  });
});
