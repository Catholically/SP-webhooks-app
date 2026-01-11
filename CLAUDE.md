# CLAUDE.md - SP-webhooks-app

## Descrizione Progetto

Integrazione SpedirePro + Shopify per automazione spedizioni internazionali di Holy Trove (catholically.com).

## Stack Tecnico

- Next.js 14 con App Router
- TypeScript
- Hosting: Vercel
- APIs: SpedirePro, Shopify GraphQL, Google Drive, Resend

## Struttura Principale

- `app/api/webhooks/orders-updated/` - Riceve webhook Shopify, crea etichette
- `app/api/webhooks/spedirepro/` - Riceve webhook SpedirePro, aggiorna tracking
- `lib/` - Utilities (doganali, email, Google Drive)

## Magazzini

- **MI** = Milano
- **RM** = Roma

## Tag System

Formato: `{MAGAZZINO}-{AZIONE}[-OPZIONI]`

Esempi:
- `MI-CREATE` - Crea etichetta DDP da Milano
- `RM-CREATE-DDU` - Crea etichetta DDU da Roma
- `MI-DOG` - Genera solo doganale

## Convenzioni

- Usare TypeScript strict
- Console.log con timestamp per debug
- Gestire errori con try/catch e logging dettagliato
- Le email MI-* vanno a denticristina@gmail.com

## Variabili Ambiente Critiche

- `SPRO_API_KEY` - API SpedirePro
- `SHOPIFY_ADMIN_TOKEN` - Token Shopify
- `RESEND_API_KEY` - Per invio email
- `SPRO_WEBHOOK_TOKEN` - Sicurezza webhook

### Google Drive (per storage etichette)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Email service account
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` - Private key service account
- `GOOGLE_DRIVE_FOLDER_ID` - ID cartella base Drive

### Google Sheets (per logging spedizioni)
- `GOOGLE_SPREADSHEET_ID` - ID foglio (`1z1Y_efzGx2pIgrruzTZExFdgFxfnqRa_V4mFJw7Q9CA`)
- Oppure `GOOGLE_SERVICE_ACCOUNT_JSON` - JSON completo credenziali (alternativo a EMAIL+KEY)

## Comandi Utili

```bash
npm run dev    # Development locale
npm run build  # Build produzione
```

## Note

- DDP = USA/EU (dazi inclusi)
- DDU = Resto mondo (dazi a carico destinatario)
- Il sistema blocca tag incompatibili con paese destinazione
