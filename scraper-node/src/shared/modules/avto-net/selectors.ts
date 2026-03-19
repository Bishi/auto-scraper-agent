export const SELECTORS = {
  /** Container for each listing row in search results */
  // INTENTIONALLY BROKEN FOR DEBUG SNAPSHOT TESTING — revert to ".GO-Results-Row" when done
  listingRow: ".GO-Results-Row-BROKEN-TEST",
  /** Title/name div - contains a <span> with the car name */
  title: ".GO-Results-Naziv span",
  /**
   * Regular price — two variants:
   *   standard listings:    .GO-Results-Price-TXT-Regular
   *   "TOP PONUDBA" listings: .GO-Results-Top-Price-TXT-Regular
   */
  priceRegular: ".GO-Results-Price-TXT-Regular, .GO-Results-Top-Price-TXT-Regular",
  /** Sale/discounted price — same dual-class pattern as priceRegular */
  priceSale: ".GO-Results-Price-TXT-AkcijaCena, .GO-Results-Top-Price-TXT-AkcijaCena",
  /** Old price before sale */
  priceOld: ".GO-Results-Price-TXT-StaraCena, .GO-Results-Top-Price-TXT-StaraCena",
  /** Link to individual listing page */
  link: "a[href*='/Ads/details.asp']",
  /**
   * Data table container — holds label→value rows.
   * Label tds have "d-none" (hidden on mobile); value tds don't.
   * Labels (Slovenian): "1.registracija", "Prevoženih", "Gorivo", "Menjalnik", "Motor"
   *
   * Two variants:
   *   standard listings:      .GO-Results-Data
   *   "TOP PONUDBA" listings: .GO-Results-Top-Data-Top
   */
  dataContainer: ".GO-Results-Data, .GO-Results-Top-Data-Top",
  /** Pagination: next page link */
  nextPage: ".GO-Rounded-R",
  /** Pagination: page number links */
  pageLinks: ".GO-Pager-Pair a",
} as const;
