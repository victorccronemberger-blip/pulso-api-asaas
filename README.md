# PULSO API

Backend privado do PULSO para catálogo, contas de clientes, cupons, pedidos,
financeiro e pagamentos pelo Asaas.

## Arquitetura

```text
src/
├── admin/               persistência MySQL e memória para testes
├── config/              validação do ambiente
├── customer/            sessão e validação do cliente
├── domain/              catálogo, preços, status e regras de parcelas
├── http/                proteção de tráfego
├── integrations/asaas/  cliente oficial do gateway
├── integrations/art/    matrícula na plataforma de cursos (ART)
├── routes/              APIs HTTP
└── services/            sincronização do parcelamento Pix
```

O Asaas é a única fonte de verdade do pagamento. O backend nunca recebe dados
brutos de cartão. O checkout de cartão usa a página segura do Asaas; Pix à vista
e Pix parcelado usam cobranças criadas uma única vez no mesmo plano.

## Pagamentos

- Pix à vista.
- Pix parcelado de 2 a 6 parcelas, com `totalValue` preservado.
- Cartão de crédito de 1 a 10 parcelas sem juros para o cliente.
- Idempotência obrigatória em toda criação de pedido.
- Webhook autenticado e deduplicado por evento.
- Ledger local para cada parcela Pix.
- Link oficial da parcela futura para pagamento antecipado, sem gerar uma
  cobrança duplicada.

Cada evento de parcela atualiza somente aquela parcela. O pedido vira
`partially_paid` após o primeiro recebimento e `paid` apenas quando todas as
parcelas forem quitadas.

## Rotas principais

| Método | Rota | Uso |
| --- | --- | --- |
| `GET` | `/health` | Saúde da aplicação e banco |
| `POST` | `/v1/customer/register` | Criar conta do cliente |
| `POST` | `/v1/customer/login` | Entrar no painel |
| `PATCH` | `/v1/customer/profile` | Atualizar os dados da conta |
| `POST` | `/v1/customer/password` | Trocar a senha autenticada |
| `POST` | `/v1/customer/password/forgot` | Solicitar recuperação por e-mail |
| `POST` | `/v1/customer/password/reset` | Redefinir senha com token de uso único |
| `POST` | `/v1/customer/email-verification/request` | Reenviar confirmação de e-mail |
| `POST` | `/v1/customer/email-verification/confirm` | Confirmar e-mail com token de uso único |
| `GET` | `/v1/customer/orders` | Histórico e planos de parcelas |
| `POST` | `/v1/customer/orders/:id/installments/refresh` | Atualização manual do plano no Asaas |
| `POST` | `/v1/checkout/orders` | Criar pedido idempotente |
| `GET` | `/v1/checkout/orders/:id` | Consultar status sanitizado |
| `POST` | `/v1/webhooks/asaas` | Receber eventos do Asaas |
| `POST` | `/v1/admin/bootstrap` | Criar o primeiro administrador |
| `GET` | `/v1/admin/overview` | Indicadores |
| `GET` | `/v1/admin/finance` | Série financeira |
| `GET` | `/v1/admin/orders` | Pedidos e recebimentos |
| `GET/POST/PATCH/DELETE` | `/v1/admin/coupons` | Gestão de cupons |
| `GET` | `/v1/admin/customers` | Clientes (com contagem de ativações) |
| `GET` | `/v1/admin/products` | Catálogo com `sourceTag`/`cohort` ART |
| `GET/PUT` | `/v1/admin/campaign` | Campanha pública |
| `GET` | `/v1/admin/audit` | Trilha de auditoria |
| `GET` | `/v1/admin/enrollments` | Matrículas (jobs) e status |
| `GET` | `/v1/admin/enrollments/:id` | Detalhe de uma matrícula |
| `POST` | `/v1/admin/enrollments/:id/requeue` | Reenfileirar matrícula falha |
| `POST` | `/v1/admin/enrollments/:id/verify` | Verificar/confirmar matrícula na plataforma |
| `POST` | `/v1/admin/course-activations` | **Ativação manual** de cursos para um cliente |
| `GET` | `/v1/public/campaign` | Campanha (loja) |
| `POST` | `/v1/public/quote` | Cotação (loja) |

Rotas de cliente e administrador usam cookies `HttpOnly`, CSRF e
`Cache-Control: no-store`.

## Configuração

Copie `.env.example` apenas no ambiente da Hostinger e preencha os segredos no
gerenciador de variáveis. Nunca grave chaves no Git.

Variáveis obrigatórias em produção:

- `MYSQL_URL`
- `SESSION_PEPPER`
- `ASAAS_ENABLED=true`
- `ASAAS_ENVIRONMENT=production`
- `ASAAS_API_KEY`
- `ASAAS_WEBHOOK_TOKEN`
- `SMTP_USER=comercial@cyara.com.br`
- `SMTP_PASSWORD`

O envio transacional usa `smtp.hostinger.com:465` com TLS por padrão. É possível
sobrescrever `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` e `EMAIL_FROM` sem criar
outra conta de e-mail.

O webhook no Asaas deve apontar para:

```text
https://api-pulso.cyara.com.br/v1/webhooks/asaas
```

e enviar o mesmo valor de `ASAAS_WEBHOOK_TOKEN` no cabeçalho
`asaas-access-token`.

## Execução

Requer Node.js 22 ou superior.

```bash
npm ci
npm test
npm run build
npm start
```

Na primeira inicialização, a aplicação cria as tabelas ausentes e aplica
migrações compatíveis sem apagar pedidos existentes.

## Matrícula em cursos (integração ART)

`src/integrations/art/` é a integração, de propriedade do operador, com a sua
própria plataforma de cursos (Academia Rafael Toro — ART). Ela libera a matrícula
do cliente quando o acesso é concedido (pagamento confirmado) **ou** por ativação
manual no painel admin (`POST /v1/admin/course-activations`).

Fluxo validado (sem nenhum token `alg=none`):

1. `x-api-key` = RSA do segredo estático de checkout da plataforma.
2. **Fase 1 — provisão**: `process/start` só com `x-api-key` + payload fiel à SPA
   de checkout (cartão cifrado RSA, `detailsCupom` objeto, `getnet_fingerprint`,
   `promo_opt_in`, `contract:true`) provisiona a conta do aluno (senha = CPF).
3. **Login real**: `e-mail + CPF` → JWT **RS256** do aluno.
4. **Fase 2 — efetivação**: `process/start` com o RS256 (`sub` == `user_id` do
   e-mail) efetiva a matrícula; polling em `findCoursesByStudent` até `APPROVED`.

A ativação manual e a automática compartilham a mesma fila serializada
(`src/integrations/art/queue.js`), com retry, heartbeat e recuperação de jobs
órfãos. Um job por vez porque o login na ART revoga o RS256 anterior.

```text
ENROLLMENT_ENABLED=true          # liga o motor de matrícula (default: false)
ART_API_BASE / ART_IDM_BASE      # origens da plataforma
ART_SERVICE_ACCOUNTS=email:senha,# descoberta de turmas em tempo real (login real)
  email2:senha2
ART_PROVISION_TIMEOUT_MS / ART_POLL_TIMEOUT_MS / ART_MAX_RETRIES / ...
```

O guard em `scripts/validate-build.mjs` proíbe `alg=none`/`forgeTransportJwt` em
todo o `src/` (incluindo `integrations/art/`) — o transporte não assinado não pode
ser reintroduzido em lugar nenhum.

## Limite de responsabilidade

O Asaas é a única fonte de verdade do pagamento; o backend nunca recebe dados
brutos de cartão. A integração ART opera exclusivamente sobre a plataforma de
cursos do próprio operador, com credenciais e fluxo autorizados.
