# CLAUDE.md - SP-webhooks-app

> **Ultimo aggiornamento**: 2026-01-26

## ⚠️ ATTENZIONE - NOMI METAFIELD ESATTI (NON INVENTARE!)

**QUESTI SONO I NOMI CORRETTI DEI METAFIELD SHOPIFY - USA SOLO QUESTI:**

| Namespace | Key | Type | Descrizione |
|-----------|-----|------|-------------|
| `custom` | `invoice` | `url` | URL fattura commerciale (Google Drive) |
| `custom` | `dichiarazione_doganale` | `url` | URL dichiarazione libera esportazione (Google Drive) |
| `custom` | `costo_spedizione` | `single_line_text_field` | Costo spedizione EUR (solo numero) |
| `spedirepro` | `tracking` | `single_line_text_field` | Tracking number |
| `spedirepro` | `reference` | `single_line_text_field` | Reference SpedirePro (es. AF110126392D5) |
| `spedirepro` | `label_url` | `url` | URL etichetta PDF (Google Drive) |
| `spedirepro` | `ldv_url` | `url` | Alias di label_url |
| `spedirepro` | `courier` | `single_line_text_field` | Nome corriere completo |
| `spedirepro` | `courier_group` | `single_line_text_field` | Gruppo corriere (UPS, FedEx) |
| `spedirepro` | `tracking_url` | `url` | URL tracking SpedirePro |
| `spedirepro` | `shipping_price` | `single_line_text_field` | Costo spedizione EUR |

**❌ NOMI SBAGLIATI DA NON USARE MAI:**
- `custom.doganale` → SBAGLIATO! Usa `custom.dichiarazione_doganale`
- `custom.declaration` → SBAGLIATO! Usa `custom.dichiarazione_doganale`
- `custom.fattura` → SBAGLIATO! Usa `custom.invoice`

---

## Descrizione Progetto

Integrazione SpedirePro + Shopify per automazione spedizioni internazionali di Holy Trove (catholically.com).

## Stack Tecnico

- Next.js 14 con App Router
- TypeScript
- Hosting: Vercel (https://webhooks.catholically.com)
- APIs: SpedirePro, Shopify GraphQL, Google Drive, Google Sheets, Resend
- Repo: https://github.com/Catholically/SP-webhooks-app
- **Vercel teamId**: `team_qcj15fBleoIF0nR9jXp5WUHi`

## Struttura Principale

```
app/api/webhooks/
├── orders-updated/route.ts  → Riceve webhook Shopify, crea etichette
└── spedirepro/route.ts      → Riceve webhook SpedirePro, aggiorna tracking

lib/
├── customs-handler.ts       → Orchestrazione documenti doganali
├── customs-pdf.ts           → Generazione PDF (invoice + declaration)
├── shopify-customs.ts       → Fetch dati prodotti da Shopify
├── google-drive.ts          → Upload PDF su Google Drive
├── google-sheets.ts         → Logging spedizioni
├── email-alerts.ts          → Notifiche errori via Resend
└── eu-countries.ts          → Logica paesi EU/USA/customs
```

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

### Tag per Invio Etichetta via Email
| Tag | Descrizione |
|-----|-------------|
| `LABEL` | Invia etichetta esistente via email a denticristina@gmail.com |

### Tag Automatici (aggiunti dal sistema)
| Tag | Significato |
|-----|-------------|
| `LABEL-OK-MI` | Etichetta creata da Milano (previene duplicati) |
| `LABEL-OK-RM` | Etichetta creata da Roma (previene duplicati) |
| `LABEL-SENT` | Etichetta inviata via email |
| `MI-DOG-DONE` | Doganale generata da Milano |
| `RM-DOG-DONE` | Doganale generata da Roma |

## Protezione Anti-Duplicati

Il sistema ha **due livelli** di protezione contro webhook duplicati:
1. Controlla tag `LABEL-OK-*` (veloce, all'inizio)
2. Controlla metafield `tracking`/`reference` (prima di creare etichetta)

**IMPORTANTE - Ordine elaborazione tag in `orders-updated`:**
1. ✅ DOG tags (MI-DOG, RM-DOG) - processati PRIMA
2. ✅ LABEL tag - processato secondo
3. ✅ LABEL-OK check - blocca solo CREATE tags (NON DOG/LABEL)
4. ✅ CREATE tags - processati per ultimi

Questo permette di rigenerare doganali su ordini con etichette esistenti.

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

---

## File Google Drive - Naming Convention

I PDF vengono salvati con struttura: `{base_folder}/MM/MMddyyyy/{filename}.pdf`

| Tipo documento | Suffisso filename | Esempio |
|----------------|-------------------|---------|
| Etichetta spedizione | (nessuno) | `36988182026.pdf` |
| Fattura commerciale | `_inv` | `36988182026_inv.pdf` |
| Dichiarazione doganale | `_dog` | `36988182026_dog.pdf` |

---

## SpedirePro Webhook Payload

Il webhook SpedirePro può avere l'URL etichetta in diversi campi (fallback order):
1. `body.label.link` (principale)
2. `body.label_url`
3. `body.ldv` (lettera di vettura)
4. `body.ldv_url`
5. `body.document_url`

---

## SpedirePro Customs Upload API (New)

Per caricare documenti doganali su SpedirePro (2 step):

**Step 1 - Upload file:**
```
POST https://www.spedirepro.com/api/documents/dogana/upload
Headers: X-Api-Key: {SPRO_API_KEY}
Body: FormData con campo "document" (PDF blob)
```

**Step 2 - Conferma upload:**
```
POST https://www.spedirepro.com/api/user/shipment/customs-uploaded
Headers: X-Api-Key: {SPRO_API_KEY}, Content-Type: application/json
Body: { "reference": "...", "document_type": 1|2, "file_path": "..." }
```

| document_type | Descrizione |
|---------------|-------------|
| 1 | Fattura commerciale (invoice) |
| 2 | Dichiarazione di Libera Esportazione |
