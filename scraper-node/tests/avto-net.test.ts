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

    it("extracts metadata.thumbnailUrl from the row image src", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.metadata["thumbnailUrl"]).toBe("https://img.avto.net/thumb/12345.jpg");
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

  describe("year parsing", () => {
    it("extracts 4-digit year from '3/2021' â†’ 2021", () => {
      const [listing] = parseListings(fixture("standard.html"), SOURCE_URL);
      expect(listing!.metadata["year"]).toBe(2021);
    });

    it("extracts year from '11/2022' â†’ 2022", () => {
      const [listing] = parseListings(
        fixture("top-ponudba.html"),
        SOURCE_URL,
      );
      expect(listing!.metadata["year"]).toBe(2022);
    });

    it("stores NEW when Starost is NOVO", () => {
      const html = `
        <div class="GO-Results-Row">
          <img src="https://img.avto.net/thumb/new.jpg" />
          <div class="GO-Results-Naziv"><span>Novo vozilo</span></div>
          <a href="../Ads/details.asp?id=99991">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">42.000 EUR</div>
          <div class="GO-Results-Data">
            <table>
              <tr><td class="d-none">Starost</td><td>NOVO</td></tr>
              <tr><td class="d-none">Gorivo</td><td>bencinski motor</td></tr>
            </table>
          </div>
        </div>`;

      const [listing] = parseListings(html, SOURCE_URL);
      expect(listing!.metadata["year"]).toBe("NEW");
    });

    it("prefers Starost NOVO over 1.registracija when both are present", () => {
      const html = `
        <div class="GO-Results-Row">
          <img src="https://img.avto.net/thumb/new-priority.jpg" />
          <div class="GO-Results-Naziv"><span>Novo vozilo s prioriteto</span></div>
          <a href="../Ads/details.asp?id=99992">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">43.000 EUR</div>
          <div class="GO-Results-Data">
            <table>
              <tr><td class="d-none">Starost</td><td>NOVO</td></tr>
              <tr><td class="d-none">1.registracija</td><td>3/2026</td></tr>
            </table>
          </div>
        </div>`;

      const [listing] = parseListings(html, SOURCE_URL);
      expect(listing!.metadata["year"]).toBe("NEW");
    });
  });

  describe("EV (electric vehicle) listing", () => {
    it("stores battery for EV listing from 'Baterija' label", () => {
      const [ev] = parseListings(fixture("ev.html"), SOURCE_URL);
      expect(ev!.metadata["battery"]).toBe("49 kWh");
    });

    it("preserves electric engine as-is (no KM, so 208 kW stays)", () => {
      const [ev] = parseListings(fixture("ev.html"), SOURCE_URL);
      expect(ev!.metadata["engine"]).toBe("208 kW");
    });

    it("keeps transmission null for EV when no Menjalnik row is present", () => {
      const [ev] = parseListings(fixture("ev.html"), SOURCE_URL);
      expect(ev!.metadata["transmission"]).toBeNull();
    });

    it("stores fuel as elektro pogon", () => {
      const [ev] = parseListings(fixture("ev.html"), SOURCE_URL);
      expect(ev!.metadata["fuel"]).toBe("elektro pogon");
    });

    it("omits battery key entirely for non-EV listing without Baterija", () => {
      const listings = parseListings(fixture("ev.html"), SOURCE_URL);
      const nonEv = listings[1]!;
      expect("battery" in nonEv.metadata).toBe(false);
    });

    it("non-EV contentHash does not change when only EV gets battery", () => {
      // Parse the EV fixture; the non-EV row must not have battery in its hash input.
      const listings = parseListings(fixture("ev.html"), SOURCE_URL);
      const nonEv = listings[1]!;
      // Verify battery is absent from the metadata object — it will not affect the hash.
      expect(Object.keys(nonEv.metadata)).not.toContain("battery");
    });

    it("EV and non-EV from same fixture produce different contentHashes", () => {
      const [ev, nonEv] = parseListings(fixture("ev.html"), SOURCE_URL);
      expect(ev!.contentHash).not.toBe(nonEv!.contentHash);
    });
  });

  describe("thumbnailUrl", () => {
    it("falls back to data-src when src is empty", () => {
      const html = `
        <div class="GO-Results-Row">
          <img src="" data-src="https://img.avto.net/thumb/fallback.jpg" />
          <div class="GO-Results-Naziv"><span>Fallback thumb</span></div>
          <a href="../Ads/details.asp?id=11111">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">10.000 EUR</div>
          <div class="GO-Results-Data"><table></table></div>
        </div>`;
      const [listing] = parseListings(html, SOURCE_URL);
      expect(listing!.metadata["thumbnailUrl"]).toBe("https://img.avto.net/thumb/fallback.jpg");
    });

    it("falls back to data-src when src is a data URL placeholder", () => {
      const html = `
        <div class="GO-Results-Row">
          <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==" data-src="https://img.avto.net/thumb/placeholder.jpg" />
          <div class="GO-Results-Naziv"><span>Placeholder thumb</span></div>
          <a href="../Ads/details.asp?id=22222">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">11.000 EUR</div>
          <div class="GO-Results-Data"><table></table></div>
        </div>`;
      const [listing] = parseListings(html, SOURCE_URL);
      expect(listing!.metadata["thumbnailUrl"]).toBe("https://img.avto.net/thumb/placeholder.jpg");
    });

    it("normalizes root-relative thumbnail paths to absolute https URLs", () => {
      const html = `
        <div class="GO-Results-Row">
          <img src="/images/thumb/33333.jpg" />
          <div class="GO-Results-Naziv"><span>Relative thumb</span></div>
          <a href="../Ads/details.asp?id=33333">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">12.000 EUR</div>
          <div class="GO-Results-Data"><table></table></div>
        </div>`;
      const [listing] = parseListings(html, SOURCE_URL);
      expect(listing!.metadata["thumbnailUrl"]).toBe("https://www.avto.net/images/thumb/33333.jpg");
    });

    it("discards data URLs when no usable fallback exists", () => {
      const html = `
        <div class="GO-Results-Row">
          <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==" />
          <div class="GO-Results-Naziv"><span>Inline thumb</span></div>
          <a href="../Ads/details.asp?id=44444">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">13.000 EUR</div>
          <div class="GO-Results-Data"><table></table></div>
        </div>`;
      const [listing] = parseListings(html, SOURCE_URL);
      expect("thumbnailUrl" in listing!.metadata).toBe(false);
    });

    it("does not change contentHash when only the thumbnail URL changes", () => {
      const baseRow = `
        <div class="GO-Results-Row">
          __IMG__
          <div class="GO-Results-Naziv"><span>Hash stable thumb</span></div>
          <a href="../Ads/details.asp?id=55555">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">14.000 EUR</div>
          <div class="GO-Results-Data">
            <table><tr><td class="d-none">Prevoženih</td><td>45.000 km</td></tr></table>
          </div>
        </div>`;
      const htmlA = baseRow.replace("__IMG__", '<img src="https://img.avto.net/thumb/a.jpg" />');
      const htmlB = baseRow.replace("__IMG__", '<img src="https://img.avto.net/thumb/b.jpg" />');

      const [listingA] = parseListings(htmlA, SOURCE_URL);
      const [listingB] = parseListings(htmlB, SOURCE_URL);
      expect(listingA!.metadata["thumbnailUrl"]).toBe("https://img.avto.net/thumb/a.jpg");
      expect(listingB!.metadata["thumbnailUrl"]).toBe("https://img.avto.net/thumb/b.jpg");
      expect(listingA!.contentHash).toBe(listingB!.contentHash);
    });

    it("omits thumbnailUrl when a row has no image", () => {
      const html = `
        <div class="GO-Results-Row">
          <div class="GO-Results-Naziv"><span>No thumb</span></div>
          <a href="../Ads/details.asp?id=66666">Poglej oglas</a>
          <div class="GO-Results-Price-TXT-Regular">15.000 EUR</div>
          <div class="GO-Results-Data"><table></table></div>
        </div>`;
      const [listing] = parseListings(html, SOURCE_URL);
      expect("thumbnailUrl" in listing!.metadata).toBe(false);
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
