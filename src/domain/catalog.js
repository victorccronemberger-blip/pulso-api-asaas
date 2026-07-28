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

// Traduz o slug de checkout para a tag do curso na plataforma ART. E o elo entre
// o pedido pago e a matricula: cada item de pedido vira um job de matricula cuja
// tag vem daqui.
const sourceTagBySlug = Object.freeze(
  Object.fromEntries(products.map((product) => [product.slug, product.sourceTag])),
);

export function getCheckoutProduct(slug) {
  return checkoutCatalog[slug] ?? null;
}

export function getSourceTag(slug) {
  return sourceTagBySlug[slug] ?? null;
}
