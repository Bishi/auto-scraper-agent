export const SELECTORS = {
  // Scoped to .EntityList--Regular to exclude "Latest ads" filler sections
  // that bolha injects when search results are sparse (class .EntityList--Latest)
  listingItem: ".EntityList--Regular .EntityList-item",
  // Text bolha renders when a search returns zero real matches.
  // IMPORTANT: bolha still populates .EntityList--Regular with unrelated
  // "suggested" listings in this case — items WILL be found by waitForSelector,
  // but they are not real results. Always check for this text before parsing.
  noResultsText: "ni rezultatov za iskanje",
  entityBody: "article.entity-body",
  title: "h3.entity-title a",
  price: ".price-item .price",
  link: "h3.entity-title a",
  image: "img.entity-thumbnail-img",
  description: ".entity-description",
  pubDate: ".entity-pub-date time",
  pagination: ".Pagination .Pagination-item a",
} as const;
