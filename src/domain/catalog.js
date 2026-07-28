import products from "./catalog-data.json" with { type: "json" };

export const checkoutCatalog = Object.freeze(
  Object.fromEntries(products.map(({ slug, title, description, priceCents }) => [
    slug,
    Object.freeze({ slug, title, description, priceCents }),
  ])),
);

export const adminCatalog = Object.freeze(products.map((product) => Object.freeze({
  slug: product.slug,
  title: product.title,
  categoryId: product.categoryId,
  priceCents: product.priceCents,
  officialPriceCents: product.officialPriceCents,
  cohort: product.cohort ?? null,
  sourceTag: product.sourceTag,
})));

export function getCheckoutProduct(slug) {
  return checkoutCatalog[slug] ?? null;
}
