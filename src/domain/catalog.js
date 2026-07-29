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

// Traduz o slug de checkout para a tag do curso na plataforma ART. É o elo entre o
// pedido pago e a matrícula: cada item de pedido vira um job cuja tag vem daqui.
const sourceTagBySlug = Object.freeze(
  Object.fromEntries(products.map((product) => [product.slug, product.sourceTag])),
);

export function getSourceTag(slug) {
  return sourceTagBySlug[slug] ?? null;
}
