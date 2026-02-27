# Scheffer AI Chatbot

Aplicacao de chat interna da Scheffer, construida com Next.js, AI SDK e integracao com Vertex AI Agent Engine, BigQuery e Google Cloud Storage.

## Creditos e origem (fork)

Este repositorio foi criado a partir de um fork de [vercel/chatbot](https://github.com/vercel/chatbot).

Customizacoes principais neste fork:

- Integracao com `google/scheffer-agent-engine` (Vertex AI Agent Engine).
- Persistencia de mensagens e metadados em BigQuery.
- Upload de arquivos para Google Cloud Storage (GCS).
- Fluxo de autenticacao Google com restricao de dominio.
- Ajustes de renderizacao e UX especificos do produto Scheffer.

## Visao geral da arquitetura

- Frontend e API: [Next.js App Router](https://nextjs.org/docs/app).
- UI: `shadcn/ui` + Tailwind CSS.
- Auth: `next-auth` com Google OAuth (dominio `scheffer.agr.br`).
- Modelo principal: Vertex AI Agent Engine.
- Modelos alternativos: Gemini direto e OpenAI direto.
- Persistencia: BigQuery (`chat_messages`, `feedbacks`, `chat_files`).
- Arquivos: Google Cloud Storage (`GCS_BUCKET_NAME`).

## Provedores de modelo suportados

| Caminho | Uso | Variaveis necessarias |
| --- | --- | --- |
| `google/scheffer-agent-engine` | Modelo principal no Agent Engine | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_REASONING_ENGINE` |
| `google/*` (Gemini direto) | Modelos Gemini via API direta | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openai/*` | Modelos GPT via API direta | `OPENAI_API_KEY` |

`AI_GATEWAY_API_KEY` e opcional (somente se voce quiser usar rotas via Vercel AI Gateway).

## Requisitos

- Node.js 20+
- `pnpm` (projeto usa `pnpm@10`)
- Projeto GCP com acesso a:
  - Vertex AI (Reasoning Engine)
  - BigQuery
  - Cloud Storage
- Credenciais Google OAuth para login

## Configuracao de ambiente

Use as variaveis definidas em [.env.example](.env.example):

```bash
cp .env.example .env.local
```

### Variaveis principais

| Variavel | Obrigatoria | Descricao |
| --- | --- | --- |
| `AUTH_SECRET` | Sim | Segredo do NextAuth |
| `AUTH_URL` | Sim | URL base da aplicacao (ex.: `http://localhost:3000`) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Sim | OAuth Google |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Sim (Agent Engine/BigQuery/GCS) | Credencial da service account (caminho de arquivo **ou** JSON inline) |
| `VERTEX_PROJECT_ID` | Sim (Agent Engine) | Projeto GCP do Agent Engine |
| `VERTEX_LOCATION` | Sim (Agent Engine) | Regiao Vertex (ex.: `us-central1`) |
| `VERTEX_REASONING_ENGINE` | Sim (Agent Engine) | ID/caminho do Reasoning Engine |
| `BQ_PROJECT_ID` / `BQ_DATASET` | Sim | BigQuery de persistencia |
| `GCS_BUCKET_NAME` | Sim | Bucket para anexos |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Condicional | Necessaria para Gemini direto |
| `OPENAI_API_KEY` | Condicional | Necessaria para OpenAI direto |

### `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`: dois formatos aceitos

O backend aceita `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` de duas formas:

1. Como caminho para arquivo JSON:

```env
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=bi-scheffer.json
```

2. Como JSON inline (string unica):

```env
GOOGLE_SERVICE_ACCOUNT_KEY_FILE='{"type":"service_account","project_id":"seu-projeto","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"svc@seu-projeto.iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token"}'
```

Notas importantes:

- No formato inline, mantenha o valor em uma linha.
- Preserve `\n` escapado dentro de `private_key`.
- Nunca versione este valor no Git.

## Rodando localmente

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

A aplicacao sobe em [http://localhost:3000](http://localhost:3000).

Observacao: `pnpm db:migrate` e seguro mesmo sem Postgres configurado; se `POSTGRES_URL` nao estiver definido, o script apenas ignora migracoes e encerra.

## Troubleshooting

### Erro `ENAMETOOLONG` ao abrir credencial

Sintoma comum:

- Tentativa de abrir um "arquivo" cujo nome inteiro e o JSON da service account.

Causa:

- Variavel de credencial malformada ou versao sem suporte ao JSON inline.

Como resolver:

- Confirme que `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` esta em um dos formatos suportados acima.
- Se usar inline, valor deve comecar com `{` e terminar com `}`.
- Reinicie o servidor (`pnpm dev`) apos alterar `.env.local`.

### Erros `bad_request:database` / falhas de BigQuery

Verifique:

- `BQ_PROJECT_ID`, `BQ_DATASET` e tabelas (`BQ_*_TABLE`) corretos.
- Permissoes da service account para consultar/gravar no BigQuery.
- Conectividade de rede com APIs Google.

### Correlacionar logs por `session_id` e `chat_id` (Agent Engine)

Nos logs do Agent Engine e na tabela `chat_messages`:

- `session_id` = sessao do provider (Vertex / Agent Engine).
- `chat_id` = conversa interna da UI (UUID da rota `/chat/:id`).

Se o projeto roda com `BQ_AUTO_CREATE_TABLES=false`, garanta que a coluna
`chat_id` exista em `chat_messages`:

```sql
ALTER TABLE `SEU_PROJETO.SEU_DATASET.chat_messages`
ADD COLUMN IF NOT EXISTS chat_id STRING;

UPDATE `SEU_PROJETO.SEU_DATASET.chat_messages`
SET chat_id = session_id
WHERE chat_id IS NULL;
```

Eventos uteis para depuracao:

- `provider_session_resolved` (reuso/criacao de sessao).
- `vertex_stream_started` e `vertex_stream_finished`.
- `provider_session_rotated` (sessao invalida recuperada).
- `vertex_stream_failed`.

Exemplo para listar eventos no Cloud Logging:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND textPayload:"[agent-engine]" AND textPayload:"\"event\":\"vertex_stream_failed\""' \
  --project="$PROJECT_ID" \
  --limit=50 \
  --freshness=2d
```

Exemplo para rastrear um `session_id` especifico:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND textPayload:"[agent-engine]" AND textPayload:"\"session_id\":\"SEU_SESSION_ID\""' \
  --project="$PROJECT_ID" \
  --limit=100 \
  --freshness=2d
```

### Timeout ou falha transitoria no BigQuery

O projeto possui retry/cooldown configuravel:

- `BQ_REQUEST_MAX_ATTEMPTS`
- `BQ_REQUEST_BASE_DELAY_MS`
- `BQ_REQUEST_MAX_DELAY_MS`
- `BQ_RATE_LIMIT_COOLDOWN_MS`

## Seguranca

- Nunca commite `.env.local`, chaves JSON ou tokens.
- Se alguma chave vazar em log/chat/git, rotacione imediatamente no GCP.
- Prefira variaveis de ambiente seguras do provedor de deploy.

## Deploy

Voce pode fazer deploy em qualquer ambiente que suporte Next.js 16 (ex.: Vercel), desde que todas as variaveis de ambiente estejam configuradas.

Fluxo comum na Vercel:

```bash
npm i -g vercel
vercel link
vercel env pull
vercel --prod
```

## Scripts uteis

| Comando | Descricao |
| --- | --- |
| `pnpm dev` | Sobe a aplicacao local |
| `pnpm build` | Roda migracoes (se `POSTGRES_URL`) e gera build de producao |
| `pnpm start` | Inicia build de producao |
| `pnpm lint` | Checagem de qualidade (Ultracite/Biome) |
| `pnpm test` | Suite Playwright |

## Licenca

Consulte [LICENSE](LICENSE).
