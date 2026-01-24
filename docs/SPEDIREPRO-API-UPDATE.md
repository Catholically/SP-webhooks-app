# Aggiornamento API SpedirePro - Upload Documenti Doganali

**Data**: Gennaio 2026

## Cosa è cambiato

SpedirePro ha aggiornato l'API per l'upload dei documenti doganali. Ora i due documenti devono essere caricati **separatamente** invece che come un unico PDF.

### Prima (deprecato)
- Un singolo PDF di 2 pagine (fattura + dichiarazione)
- Upload via `POST /shipment/{reference}/upload`

### Ora (nuovo)
- **Due PDF separati**
- Upload in **due step** per ogni documento

---

## Nuova Struttura API

### Tipi di Documento
| document_type | Documento |
|---------------|-----------|
| 1 | Fattura Commerciale (Commercial Invoice) |
| 2 | Dichiarazione di Libera Esportazione |

---

## Processo di Upload (2 step per documento)

### Step 1: Upload del file

```
POST https://www.spedirepro.com/api/documents/dogana/upload
```

**Headers:**
```
X-Api-Key: {YOUR_API_KEY}
Content-Type: multipart/form-data
```

**Body (form-data):**
```
document: [file PDF]
```

**Risposta:** 200 OK se upload riuscito

---

### Step 2: Conferma upload con tipo documento

```
POST https://www.spedirepro.com/api/user/shipment/customs-uploaded
```

**Headers:**
```
X-Api-Key: {YOUR_API_KEY}
Content-Type: application/json
```

**Body JSON:**
```json
{
  "reference": "AF110126392D5",
  "document_type": 1,
  "file_path": "{tracking}_{document_type}_{reference}.pdf"
}
```

**Parametri:**
| Campo | Tipo | Descrizione |
|-------|------|-------------|
| reference | string | Reference della spedizione SpedirePro |
| document_type | number | 1 = Fattura, 2 = Dichiarazione |
| file_path | string | Nome file nel formato `{tracking}_{type}_{reference}.pdf` |

---

## Esempio Completo in JavaScript/TypeScript

```typescript
async function uploadDocumentToSpedirePro(
  reference: string,
  tracking: string,
  pdfBuffer: Buffer,
  documentType: number,  // 1 = Invoice, 2 = Declaration
  filename: string
): Promise<boolean> {
  const SPRO_API_KEY = process.env.SPRO_API_KEY;
  const SPRO_WEB_BASE = "https://www.spedirepro.com";

  // Step 1: Upload del file
  const formData = new FormData();
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('document', blob, filename);

  const uploadResponse = await fetch(
    `${SPRO_WEB_BASE}/api/documents/dogana/upload`,
    {
      method: 'POST',
      headers: {
        'X-Api-Key': SPRO_API_KEY,
      },
      body: formData,
    }
  );

  if (!uploadResponse.ok) {
    console.error('Upload failed:', await uploadResponse.text());
    return false;
  }

  // Step 2: Conferma con document_type
  const filePath = `${tracking}_${documentType}_${reference}.pdf`;
  const confirmResponse = await fetch(
    `${SPRO_WEB_BASE}/api/user/shipment/customs-uploaded`,
    {
      method: 'POST',
      headers: {
        'X-Api-Key': SPRO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reference: reference,
        document_type: documentType,
        file_path: filePath,
      }),
    }
  );

  return confirmResponse.ok;
}

// Utilizzo
await uploadDocumentToSpedirePro(reference, tracking, invoiceBuffer, 1, 'invoice.pdf');
await uploadDocumentToSpedirePro(reference, tracking, declarationBuffer, 2, 'declaration.pdf');
```

---

## Note Importanti

1. **Ordine**: Entrambi i documenti possono essere caricati in parallelo
2. **Autenticazione**: Usa sempre l'header `X-Api-Key`
3. **Reference**: È il codice univoco della spedizione SpedirePro (es. `AF110126392D5`)
4. **File path**: Il formato deve essere `{tracking}_{document_type}_{reference}.pdf`

---

## Riferimenti

- Documentazione API: https://spedirepro.readme.io/reference/autenticazione-e-webhook
- Interfaccia web upload: Sezione "Documenti Dogana" nella scheda spedizione
