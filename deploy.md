# Deploy no Cloud Run (gcloud CLI)

Este guia configura deploy da aplicacao no **mesmo servico Cloud Run** (atualiza revisoes, nao cria um novo servico por deploy).

## 1) Variaveis base

```fish
set -x PROJECT_ID "bi-scheffer"
set -x REGION "us-central1"
set -x SERVICE_NAME "ai-chatbot"

set -x RUNTIME_SA_NAME "ai-chatbot-runtime"
set -x DEPLOYER_SA_NAME "github-cloud-run-deployer"

set -x GITHUB_OWNER "scheffer-business-intelligence"
set -x GITHUB_REPO "ai-chatbot"
```

## 2) Autenticacao e projeto

```fish
gcloud auth login
gcloud config set project "$PROJECT_ID"
```

## 3) Ativar APIs necessarias

```fish
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  aiplatform.googleapis.com \
  bigquery.googleapis.com \
  storage.googleapis.com
```

## 4) Service Accounts (runtime e deploy)

```fish
gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
  --display-name="AI Chatbot Runtime SA"; or true

gcloud iam service-accounts create "$DEPLOYER_SA_NAME" \
  --display-name="GitHub Cloud Run Deployer SA"; or true

set -x RUNTIME_SA_EMAIL "$RUNTIME_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
set -x DEPLOYER_SA_EMAIL "$DEPLOYER_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
```

Permissoes do runtime:

```fish
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA_EMAIL" \
  --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA_EMAIL" \
  --role="roles/bigquery.jobUser"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA_EMAIL" \
  --role="roles/bigquery.dataEditor"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA_EMAIL" \
  --role="roles/storage.objectAdmin"
```

Permissoes do deployer (GitHub Actions):

```fish
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER_SA_EMAIL" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER_SA_EMAIL" \
  --role="roles/cloudbuild.builds.editor"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER_SA_EMAIL" \
  --role="roles/artifactregistry.writer"

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA_EMAIL" \
  --member="serviceAccount:$DEPLOYER_SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"
```

## 5) Segredos no Secret Manager

Crie os segredos (ou novas versoes) para:

- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

Exemplo para criar um segredo:

```fish
printf '%s' 'valor-do-segredo' | gcloud secrets create AUTH_SECRET \
  --replication-policy="automatic" \
  --data-file=-
```

Exemplo para adicionar nova versao:

```fish
printf '%s' 'novo-valor' | gcloud secrets versions add AUTH_SECRET \
  --data-file=-
```

Permitir acesso dos segredos ao runtime:

```fish
for secret in AUTH_SECRET AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET GOOGLE_SERVICE_ACCOUNT_KEY_FILE OPENAI_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$RUNTIME_SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor"
end
```

## 6) Primeiro deploy (bootstrap do servico)

Execute na raiz do repositorio:

```fish
gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source=. \
  --service-account="$RUNTIME_SA_EMAIL" \
  --allow-unauthenticated \
  --quiet \
  --set-env-vars="AUTH_TRUST_HOST=true,AUTH_GOOGLE_ALLOWED_DOMAIN=scheffer.agr.br,BQ_PROJECT_ID=$PROJECT_ID,BQ_DATASET=scheffer_agente,BQ_AUTO_CREATE_TABLES=false,BQ_MESSAGES_TABLE=chat_messages,BQ_FEEDBACKS_TABLE=feedbacks,BQ_FILES_TABLE=chat_files,GCS_BUCKET_NAME=bi-scheffer-chat-files,VERTEX_PROJECT_ID=$PROJECT_ID,VERTEX_LOCATION=$REGION,VERTEX_REASONING_ENGINE=projects/$PROJECT_ID/locations/$REGION/reasoningEngines/7567035834935803904,OPENAI_REASONING_EFFORT=medium,AGENT_ENGINE_MAX_INLINE_FILE_BYTES=5242880" \
  --set-secrets="AUTH_SECRET=AUTH_SECRET:latest,AUTH_GOOGLE_ID=AUTH_GOOGLE_ID:latest,AUTH_GOOGLE_SECRET=AUTH_GOOGLE_SECRET:latest,GOOGLE_SERVICE_ACCOUNT_KEY_FILE=GOOGLE_SERVICE_ACCOUNT_KEY_FILE:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,GOOGLE_GENERATIVE_AI_API_KEY=GOOGLE_GENERATIVE_AI_API_KEY:latest"
```

Depois, ajuste `AUTH_URL` para a URL final do servico:

```fish
set SERVICE_URL (gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')

gcloud run services update "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --update-env-vars="AUTH_URL=$SERVICE_URL"
```

## 7) Deploy manual de atualizacao (mesmo servico)

Este comando publica nova revisao no servico existente:

```fish
gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source=. \
  --service-account="$RUNTIME_SA_EMAIL" \
  --quiet
```

## 8) GitHub Actions com Workload Identity Federation

```fish
set -x PROJECT_NUMBER (gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
set -x WIF_POOL_ID "github-pool"
set -x WIF_PROVIDER_ID "github-provider"
```

```fish
gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --display-name="GitHub Actions Pool"; or true

gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$WIF_POOL_ID" \
  --display-name="GitHub Actions Provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"; or true
```

Permitir que o repositorio assuma a SA de deploy:

```fish
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WIF_POOL_ID/attribute.repository/$GITHUB_OWNER/$GITHUB_REPO"
```

Valor do provider para usar no GitHub:

```fish
echo "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WIF_POOL_ID/providers/$WIF_PROVIDER_ID"
```

Configure no GitHub (Repository Secrets):

- `GCP_WIF_PROVIDER`: output do comando acima
- `GCP_DEPLOYER_SA`: `$DEPLOYER_SA_EMAIL`

Configure no GitHub (Repository Variables):

- `GCP_PROJECT_ID`: `$PROJECT_ID`
- `GCP_REGION`: `$REGION`
- `CLOUD_RUN_SERVICE`: `$SERVICE_NAME`
- `CLOUD_RUN_RUNTIME_SA`: `$RUNTIME_SA_EMAIL`
