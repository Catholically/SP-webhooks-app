# SP-webhooks-app

Integrazione **SpedirePro + Shopify** per automazione spedizioni internazionali.

## Cosa fa

- Crea automaticamente etichette di spedizione tramite SpedirePro (UPS/FedEx)
- Aggiorna gli ordini Shopify con tracking e URL lettera di vettura
- Genera automaticamente dichiarazioni doganali per spedizioni extra-EU
- Notifica via email le spedizioni MI- (Milano) con PDF allegato
- Auto-fulfillment degli ordini completati

## Tech Stack

- **Next.js 14** + TypeScript
- **Vercel** (hosting)
- **APIs**: SpedirePro, Shopify GraphQL, Google Drive, Resend

---

## Tag Disponibili

### Magazzini

| Codice | Località |
|--------|----------|
| `MI` | Milano |
| `RM` | Roma |

### Tag per Creare Etichette

| Tag | Descrizione | Paesi supportati |
|-----|-------------|------------------|
| `MI-CREATE` | Crea etichetta da Milano (DDP) + doganale auto | USA, EU |
| `RM-CREATE` | Crea etichetta da Roma (DDP) + doganale auto | USA, EU |
| `MI-CREATE-DDU` | Crea etichetta da Milano (DDU) + doganale auto | Resto del mondo |
| `RM-CREATE-DDU` | Crea etichetta da Roma (DDU) + doganale auto | Resto del mondo |
| `MI-CREATE-NODOG` | Crea etichetta da Milano (DDP) senza doganale | USA, EU |
| `RM-CREATE-NODOG` | Crea etichetta da Roma (DDP) senza doganale | USA, EU |
| `MI-CREATE-DDU-NODOG` | Crea etichetta da Milano (DDU) senza doganale | Resto del mondo |
| `RM-CREATE-DDU-NODOG` | Crea etichetta da Roma (DDU) senza doganale | Resto del mondo |

### Tag per Doganale Manuale

| Tag | Descrizione |
|-----|-------------|
| `MI-DOG` | Genera solo dichiarazione doganale (richiede tracking esistente) |
| `RM-DOG` | Genera solo dichiarazione doganale (richiede tracking esistente) |

### Tag Automatici (aggiunti dal sistema)

| Tag | Significato |
|-----|-------------|
| `LABEL-CREATED` | Etichetta creata con successo |
| `MI-DOG-DONE` | Doganale generata da Milano |
| `RM-DOG-DONE` | Doganale generata da Roma |

---

## DDP vs DDU

| Tipo | Significato | Quando usare |
|------|-------------|--------------|
| **DDP** | Delivered Duty Paid | Spedizioni verso USA e EU (dazi inclusi) |
| **DDU** | Delivered Duty Unpaid | Spedizioni verso resto del mondo (dazi a carico destinatario) |

**Attenzione:** Il sistema blocca automaticamente l'uso di tag incompatibili con il paese di destinazione e invia alert email.

---

## Notifiche Email

Le spedizioni con tag `MI-*` inviano automaticamente una email a `denticristina@gmail.com` con:
- Dettagli ordine
- Numero tracking
- PDF etichetta allegato

---

## Flusso Operativo

```
1. Aggiungi tag (es. MI-CREATE) all'ordine Shopify
2. Webhook Shopify → /api/webhooks/orders-updated
3. Sistema crea etichetta via SpedirePro API
4. SpedirePro webhook → /api/webhooks/spedirepro
5. Sistema aggiorna Shopify con:
   - Tracking number
   - URL lettera di vettura
   - Metafields spedirepro.*
6. Auto-fulfillment ordine
7. (Se extra-EU) Genera dichiarazione doganale su Google Drive
8. (Se MI-*) Invia email notifica con PDF
```

---

## API Endpoints

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/api/ping` | GET | Health check |
| `/api/webhooks/orders-updated` | POST | Riceve webhook Shopify |
| `/api/webhooks/spedirepro?token=XXX` | POST | Riceve webhook SpedirePro |

---

## Setup

Vedi [SETUP.md](./SETUP.md) per la configurazione completa delle variabili ambiente e webhook.

---

## Struttura Progetto

```
SP-webhooks-app/
├── app/
│   ├── api/
│   │   ├── ping/              # Health check
│   │   └── webhooks/
│   │       ├── orders-updated/  # Shopify webhook handler
│   │       └── spedirepro/      # SpedirePro webhook handler
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── customs-handler.ts     # Logica doganale
│   ├── customs-pdf.ts         # Generazione PDF doganale
│   ├── email-alerts.ts        # Alert email errori
│   ├── email-label.ts         # Email etichette MI-*
│   ├── eu-countries.ts        # Lista paesi EU
│   ├── google-drive.ts        # Upload Google Drive
│   └── shopify-customs.ts     # Metafields Shopify
├── SETUP.md                   # Guida configurazione
└── README.md                  # Questo file
```
