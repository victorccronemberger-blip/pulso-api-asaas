const products = [
  ["novo-cpa", "Novo CPA", "Formação para a nova certificação de entrada da ANBIMA.", 149_700],
  ["cpro-i", "CPRO-I", "Aprofundamento técnico em investimentos e produtos financeiros.", 299_700],
  ["cpro-r", "CPRO-R", "Relacionamento, recomendação e atendimento qualificado.", 299_700],
  ["cfp-modular-completo", "CFP Modular — Completo", "Formação CFP organizada em uma rota modular completa.", 999_700],
  ["cfp-modular-8-modulos", "CFP Modular — 8 Módulos", "Oito frentes de estudo para personalizar sua preparação CFP.", 999_700],
  ["cfp-60-dias-2026", "CFP 60 Dias 2026", "Preparação intensiva com calendário objetivo para 2026.", 999_800],
  ["cfp-60-dias-exame-54", "CFP 60 Dias — Exame 54", "Rota intensiva direcionada para a edição 54 do exame CFP.", 999_800],
  ["cfg-2026", "CFG 2026", "Fundamentos para ingressar na gestão profissional de recursos.", 600_000],
  ["cge-2026", "CGE 2026", "Preparação para gestão de fundos estruturados e governança.", 200_000],
  ["cga-2026", "CGA 2026", "Gestão ativa, alocação e decisão institucional de portfólio.", 400_000],
  ["ancord-2026", "Ancord 2026", "Preparação para atuação como assessor de investimentos.", 99_700],
  ["simulados-cfp-2026", "Simulados CFP 2026", "Diagnóstico de prova e treino de ritmo para o CFP.", 199_700],
  ["simulados-cfg-2026", "Simulados CFG 2026", "Prática dirigida para medir sua preparação para o CFG.", 99_700],
  ["simulados-cge-2026", "Simulados CGE 2026", "Questões e diagnóstico para o exame CGE.", 99_700],
  ["simulados-cga-2026", "Simulados CGA 2026", "Treino de decisão e domínio técnico para o CGA.", 99_700],
  ["simulados-ancord-2026", "Simulados Ancord 2026", "Prática de prova para conquistar a certificação ANCORD.", 43_000],
  ["matematica-financeira-2024-2026", "Matemática Financeira 2024/2026", "Valor do dinheiro no tempo, juros e decisões financeiras.", 49_700],
  ["excel-basico-mercado-financeiro", "Excel Básico — Mercado Financeiro", "Planilhas e organização de dados para começar com segurança.", 49_700],
  ["ia-mercado-financeiro", "IA para Mercado Financeiro", "Inteligência artificial aplicada a pesquisa, análise e produtividade.", 49_700],
];

export const checkoutCatalog = Object.freeze(
  Object.fromEntries(products.map(([slug, title, description, priceCents]) => [
    slug,
    Object.freeze({ slug, title, description, priceCents }),
  ])),
);

export function getCheckoutProduct(slug) {
  return checkoutCatalog[slug] ?? null;
}
