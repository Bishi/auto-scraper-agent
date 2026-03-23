import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseListings,
  parsePaginationLinks,
} from "../src/shared/modules/bolha/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures/bolha", name), "utf-8");

const SOURCE_URL = "https://www.bolha.com/search?query=bmw";

describe("bolha parser — parseListings", () => {
  it("parses two listings from fixture", () => {
    const listings = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listings).toHaveLength(2);
  });

  it("extracts sourceId from 'name' attribute on title anchor", () => {
    const [listing] = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listing!.sourceId).toBe("12345678");
  });

  it("extracts title, price and listingUrl from first listing", () => {
    const [listing] = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listing!.title).toBe("BMW 320d");
    expect(listing!.price).toBe(9500);
    expect(listing!.listingUrl).toBe(
      "https://www.bolha.com/avtomobili/bmw-320d-oglas-12345678",
    );
    expect(listing!.moduleName).toBe("bolha");
    expect(listing!.sourceUrl).toBe(SOURCE_URL);
  });

  it("extracts location and pubDate into metadata", () => {
    const [listing] = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listing!.metadata["location"]).toBe("Ljubljana");
    expect(listing!.metadata["pubDate"]).toBe("2024-01-15T10:30:00");
  });

  it("returns null price for 'Po dogovoru'", () => {
    const listings = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listings[1]!.price).toBeNull();
  });

  it("contentHash is a 64-char hex string", () => {
    const [listing] = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listing!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("contentHash differs between two listings with different fields", () => {
    const listings = parseListings(fixture("listings.html"), SOURCE_URL);
    expect(listings[0]!.contentHash).not.toBe(listings[1]!.contentHash);
  });

  it("returns empty array when no EntityList--Regular items exist", () => {
    const listings = parseListings(fixture("empty.html"), SOURCE_URL);
    expect(listings).toHaveLength(0);
  });

});

describe("bolha parser — parsePaginationLinks", () => {
  it("extracts all pagination URLs", () => {
    const links = parsePaginationLinks(fixture("pagination.html"), SOURCE_URL);
    expect(links).toHaveLength(3);
    expect(links).toContain("https://www.bolha.com/search?page=1");
    expect(links).toContain("https://www.bolha.com/search?page=2");
    expect(links).toContain("https://www.bolha.com/search?page=3");
  });

  it("excludes the base URL from pagination results", () => {
    const links = parsePaginationLinks(fixture("pagination.html"), SOURCE_URL);
    expect(links).not.toContain(SOURCE_URL);
  });

  it("returns empty array when no pagination element is present", () => {
    const links = parsePaginationLinks(fixture("empty.html"), SOURCE_URL);
    expect(links).toHaveLength(0);
  });

  it("returns unique URLs (no duplicates)", () => {
    const links = parsePaginationLinks(fixture("pagination.html"), SOURCE_URL);
    const unique = new Set(links);
    expect(unique.size).toBe(links.length);
  });
});

describe("bolha parser — sourceId extraction", () => {
  it("falls back to -oglas- pattern when no name attr", () => {
    const html = `
      <ul class="EntityList EntityList--Regular">
        <li class="EntityList-item">
          <article class="entity-body">
            <h3 class="entity-title">
              <a href="/auta/ford-focus-oglas-99887766">Ford Focus</a>
            </h3>
          </article>
        </li>
      </ul>`;
    const [listing] = parseListings(html, SOURCE_URL);
    expect(listing!.sourceId).toBe("99887766");
  });

  it("falls back to trailing digits when no name attr and no -oglas- pattern", () => {
    const html = `
      <ul class="EntityList EntityList--Regular">
        <li class="EntityList-item">
          <article class="entity-body">
            <h3 class="entity-title">
              <a href="/auta/12345678">Some Title</a>
            </h3>
          </article>
        </li>
      </ul>`;
    const [listing] = parseListings(html, SOURCE_URL);
    expect(listing!.sourceId).toBe("12345678");
  });
});
