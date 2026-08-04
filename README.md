# PULSO API

Serviço de pagamentos do PULSO Bancário. Única responsabilidade: cobranças via
**Asaas** (Pix, Pix parcelado e cartão hospedado) e persistência dos pedidos em
MySQL. O frontend/LMS em `https://pulso.cyara.com.br` consome esta API; a
entrega dos cursos acontece lá.

## Rotas

| Método | Rota | Uso |
| --- | --- | --- |
| `GET` | `/health` | Saúde da aplicação e do banco |
| `GET` | `/v1/checkout/status` | Capacidades do checkout |
| `POST` | `/v1/checkout/installments` | Opções de parcelamento de um carrinho |
| `POST` | `/v1/checkout/orders` | Criar cobrança (exige `x-pulso-trusted-token`) |
| `GET` | `/v1/checkout/orders/:id` | Status sanitizado do pedido |
| `GET` | `/v1/checkout/orders/:id/pix` | Recuperação do QR Code Pix |
| `POST` | `/v1/webhooks/asaas` | Webhook autenticado e deduplicado da Asaas |
| `GET` | `/v1/public/products` | Catálogo ativo |
| `POST` | `/v1/public/quote` | Cotação autoritativa (preço vem do servidor) |

### Checkout servidor-a-servidor

`POST /v1/checkout/orders` só aceita chamadas do frontend confiável: o cabeçalho
`x-pulso-trusted-token` deve conter o valor de `TRUSTED_CHECKOUT_TOKEN`
(comparação em tempo constante). O corpo leva `slugs`, `couponCode` (opcional),
`buyer` (nome, e-mail, telefone, CPF/CNPJ e, quando houver, nascimento e
endereço) e `payment` (`pix`, `pix_installment` 2–6 ou `credit_card` 1–10),
além do cabeçalho `Idempotency-Key` (UUID obrigatório).

A Asaas redireciona o pagador para
`{PUBLIC_ORIGIN}/checkout/sucesso/?order_id=...` — rota servida pelo LMS, que
confirma o status em `GET /v1/checkout/orders/:id` e libera o curso.

O cartão usa a página segura da Asaas (hosted invoice): esta API nunca recebe
dados de cartão. O webhook (`asaas-access-token`) confirma os pagamentos e
reconcilia pedidos criados fora do fluxo.

## Banco de dados

As tabelas usam o prefixo `pulso_` porque o banco é compartilhado com o LMS
(install.sql do template cria tabelas próprias, incluindo `coupons`). Na
primeira inicialização a aplicação cria as tabelas ausentes e carrega o
catálogo da tabela `pulso_products` — se ela estiver vazia em produção, o
serviço responde 503 até o catálogo existir:

```bash
MYSQL_URL='mysql://usuario:senha@srv2037.hstgr.io:3306/base' node scripts/migrate-catalog-to-mysql.mjs
```

## Configuração

Variáveis (somente no gerenciador de segredos da hospedagem, nunca no Git):

- `MYSQL_URL` — conexão MySQL
- `ASAAS_ENABLED=true`, `ASAAS_ENVIRONMENT=production`, `ASAAS_API_KEY`
- `ASAAS_WEBHOOK_TOKEN` — mesmo token configurado no webhook da Asaas
- `TRUSTED_CHECKOUT_TOKEN` — segredo compartilhado com o LMS
- `PUBLIC_ORIGIN` — origem do frontend (padrão `https://pulso.cyara.com.br`)

O webhook no painel da Asaas deve apontar para:

```text
https://api-pulso.cyara.com.br/v1/webhooks/asaas
```

## Execução

Requer Node.js 22 ou superior.

```bash
npm ci
npm test
npm run build
npm start
```
