# Aggiornamento API SpedirePro - Upload Documenti Doganali

**Data**: Gennaio 2026
**Documentazione ufficiale**: https://spedirepro.readme.io/reference/upload-documentazione-doganale

## API Attuale (Gennaio 2026)

SpedirePro ha semplificato l'API per l'upload dei documenti doganali. Ora è un singolo endpoint.

### Endpoint

```
POST https://www.spedirepro.com/public-api/v1/shipment/{reference}/upload
```

### Headers

| Header | Valore |
|--------|--------|
| `X-Api-Key` | API key SpedirePro (obbligatorio) |
| `Content-Type` | `multipart/form-data` |

### Path Parameters

| Parametro | Tipo | Descrizione |
|-----------|------|-------------|
| `reference` | string | Reference della spedizione SpedirePro (es. `AF110126392D5`) |

### Body (multipart/form-data)

| Campo | Tipo | Obbligatorio | Descrizione |
|-------|------|--------------|-------------|
| `document` | binary | Sì | File PDF, JPG o PNG |
| `document_type` | string | No | `invoice` o `export_declaration` (default: `invoice`) |

### Tipi di Documento

| document_type | Documento |
|---------------|-----------|
| `invoice` | Fattura Commerciale (Commercial Invoice) |
| `export_declaration` | Dichiarazione di Libera Esportazione EUR.1/A.TR. |

### Response

**Success (200)**:
```json
{}
```

**Error (422)**: Errore di validazione

---

## Esempio TypeScript

```typescript
async function uploadDocumentToSpedirePro(
  reference: string,
  pdfBuffer: Buffer,
  documentType: 'invoice' | 'export_declaration',
  filename: string
): Promise<boolean> {
  const SPRO_API_KEY = process.env.SPRO_API_KEY;
  const SPRO_API_BASE = "https://www.spedirepro.com/public-api/v1";

  const formData = new FormData();
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('document', blob, filename);
  formData.append('document_type', documentType);

  const response = await fetch(
    `${SPRO_API_BASE}/shipment/${reference}/upload`,
    {
      method: 'POST',
      headers: {
        'X-Api-Key': SPRO_API_KEY,
      },
      body: formData,
    }
  );

  return response.ok;
}

// Utilizzo
await uploadDocumentToSpedirePro(reference, invoiceBuffer, 'invoice', 'invoice.pdf');
await uploadDocumentToSpedirePro(reference, declarationBuffer, 'export_declaration', 'declaration.pdf');
```

---

## Migrazione da API Precedente

### Prima (deprecato - 2 step)

1. Upload file: `POST /api/documents/dogana/upload`
2. Conferma: `POST /api/user/shipment/customs-uploaded` con `document_type: 1|2` e `file_path`

### Ora (1 step)

1. Upload diretto: `POST /public-api/v1/shipment/{reference}/upload` con `document_type: 'invoice'|'export_declaration'`

### Cambio tipi documento

| Vecchio | Nuovo |
|---------|-------|
| `1` | `'invoice'` |
| `2` | `'export_declaration'` |

---

## File Modificati

- `lib/customs-pdf.ts` - Costanti `DOCUMENT_TYPE_INVOICE` e `DOCUMENT_TYPE_DECLARATION`
- `lib/customs-handler.ts` - Funzione `uploadDocumentToSpedirePro()`
- `app/api/proxy/spro-upload/route.ts` - Proxy endpoint

---

## Note

- I due documenti possono essere caricati in parallelo
- Il reference è il codice univoco della spedizione SpedirePro
- L'API restituisce un oggetto vuoto `{}` in caso di successo
