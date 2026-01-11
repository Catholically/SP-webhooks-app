# CLAUDE.md - SP-webhooks-app

> **Ultimo aggiornamento**: 2026-01-11

## Descrizione Progetto

Integrazione SpedirePro + Shopify per automazione spedizioni internazionali di Holy Trove (catholically.com).

## Stack Tecnico

- Next.js 14 con App Router
- TypeScript
- Hosting: Vercel (https://webhooks.catholically.com)
- APIs: SpedirePro, Shopify GraphQL, Google Drive, Google Sheets, Resend
- Repo: https://github.com/Catholically/SP-webhooks-app

## Struttura Principale

- `app/api/webhooks/orders-updated/` - Riceve webhook Shopify, crea etichette
- `app/api/webhooks/spedirepro/` - Riceve webhook SpedirePro, aggiorna tracking
- `lib/` - Utilities (doganali, email, Google Drive, Google Sheets)

## Magazzini

- **MI** = Milano (email notifiche: denticristina@gmail.com)
- **RM** = Roma

## Tag System

### Tag per Creare Etichette
| Tag | Descrizione | Paesi |
|-----|-------------|-------|
| `MI-CREATE` | Etichetta DDP da Milano + doganale auto | USA, EU |
| `RM-CREATE` | Etichetta DDP da Roma + doganale auto | USA, EU |
| `MI-CREATE-DDU` | Etichetta DDU da Milano + doganale auto | Resto mondo |
| `RM-CREATE-DDU` | Etichetta DDU da Roma + doganale auto | Resto mondo |
| `MI-CREATE-NODOG` | Etichetta DDP senza doganale | USA, EU |
| `RM-CREATE-NODOG` | Etichetta DDP senza doganale | USA, EU |
| `MI-CREATE-DDU-NODOG` | Etichetta DDU senza doganale | Resto mondo |
| `RM-CREATE-DDU-NODOG` | Etichetta DDU senza doganale | Resto mondo |

### Tag per Doganale Manuale
| Tag | Descrizione |
|-----|-------------|
| `MI-DOG` | Solo doganale (richiede tracking esistente) |
| `RM-DOG` | Solo doganale (richiede tracking esistente) |

### Tag Automatici (aggiunti dal sistema)
| Tag | Significato |
|-----|-------------|
| `LABEL-OK-MI` | Etichetta creata da Milano (previene duplicati) |
| `LABEL-OK-RM` | Etichetta creata da Roma (previene duplicati) |
| `MI-DOG-DONE` | Doganale generata da Milano |
| `RM-DOG-DONE` | Doganale generata da Roma |

## Protezione Anti-Duplicati

Il sistema ha **due livelli** di protezione contro webhook duplicati:
1. Controlla tag `LABEL-OK-*` (veloce, all'inizio)
2. Controlla metafield `tracking`/`reference` (prima di creare etichetta)

## Metafield Shopify

| Namespace | Key | Descrizione |
|-----------|-----|-------------|
| spedirepro | ldv_url | URL etichetta PDF (Google Drive) |
| spedirepro | label_url | Alias di ldv_url |
| spedirepro | courier | Nome corriere completo |
| spedirepro | courier_group | Gruppo corriere (UPS, FedEx) |
| spedirepro | tracking | Tracking number |
| spedirepro | tracking_url | URL tracking SpedirePro |
| spedirepro | reference | Reference SpedirePro |
| spedirepro | order_ref | Order reference SpedirePro |
| spedirepro | shipping_price | Costo spedizione EUR |
| spro | reference | Reference (duplicato) |
| custom | costo_spedizione | Costo EUR (usato da Shopify) |
| custom | doganale | URL dichiarazione doganale |

## Variabili Ambiente

### SpedirePro
- `SPRO_API_KEY` - API SpedirePro (DDP)
- `SPRO_API_KEY_NODDP` - API SpedirePro (DDU)
- `SPRO_WEBHOOK_TOKEN` - Sicurezza webhook

### Shopify
- `SHOPIFY_ADMIN_TOKEN` - Token Admin API
- `SHOPIFY_STORE` - holy-trove

### Google Drive (storage etichette)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_DRIVE_FOLDER_ID`

### Google Sheets (logging spedizioni)
- `GOOGLE_SPREADSHEET_ID` - `1z1Y_efzGx2pIgrruzTZExFdgFxfnqRa_V4mFJw7Q9CA`
- `GOOGLE_SERVICE_ACCOUNT_JSON` - Credenziali complete

### Email
- `RESEND_API_KEY` - Per invio email

## Google Sheets

- **Foglio condiviso con Easyship**: https://docs.google.com/spreadsheets/d/1z1Y_efzGx2pIgrruzTZExFdgFxfnqRa_V4mFJw7Q9CA/edit
- **Colonne**: Data | Order | Shipment ID | Tracking | Corriere | Costo | URL | Source
- **Source**: "SpedirePro" (per distinguere da "Easyship")

## Flusso Operativo

1. Aggiungi tag (es. MI-CREATE) all'ordine Shopify
2. Webhook Shopify → `/api/webhooks/orders-updated`
3. Sistema crea etichetta via SpedirePro API
4. SpedirePro webhook → `/api/webhooks/spedirepro`
5. Sistema:
   - Scarica etichetta e carica su Google Drive
   - Aggiorna metafield Shopify
   - Aggiunge tag LABEL-OK-MI/RM
   - Fetch costo da SpedirePro API
   - Logga su Google Sheets
   - Auto-fulfillment ordine
6. (Se extra-EU) Genera dichiarazione doganale
7. (Se MI-*) Invia email con PDF

## Comandi

```bash
npm run dev    # Development locale
npm run build  # Build produzione
git add . && git commit -m "msg" && git push && vercel --prod  # Deploy
```

## Note

- DDP = USA/EU (dazi inclusi)
- DDU = Resto mondo (dazi a carico destinatario)
- Il sistema blocca tag incompatibili con paese destinazione
- Costi in EUR (solo numero, senza simbolo)
