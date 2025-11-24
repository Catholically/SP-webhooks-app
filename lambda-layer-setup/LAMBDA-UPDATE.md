# Aggiornamento Lambda Function - Debug e Fallback

Questa guida spiega come scaricare, modificare e redeployare la Lambda function `process_pdf` per aggiungere debug logging e fallback per i tassi di cambio.

## 🎯 Obiettivo

Modificare `process_pdf.py` per:
1. ✅ Aggiungere logging dopo l'estrazione di Claude
2. ✅ Usare un tasso di cambio di default (0.95) se DynamoDB non ha i dati

## 📋 Prerequisiti

- AWS CLI configurato
- Git Bash (su Windows)
- Python 3.x installato

## 🚀 Procedura Step-by-Step

### Step 1: Scarica il codice della Lambda

```bash
cd /c/F24-Automation/lambda-layer-setup
chmod +x 3-download-lambda.sh
./3-download-lambda.sh
```

Questo scarica il codice corrente della Lambda in `lambda-code/`.

### Step 2: Applica le modifiche automaticamente

```bash
python 4-patch-lambda.py
```

Questo script:
- ✅ Aggiunge logging dopo l'estrazione dei dati
- ✅ Aggiunge fallback al tasso di cambio (0.95)
- ✅ Crea un backup del file originale (`.backup`)

**Se lo script automatico non funziona**, modifica manualmente `lambda-code/process_pdf.py`:

#### Modifica 1: Aggiungi debug logging

Dopo la riga dove estrai i dati con Claude (cerca `extracted_data =`), aggiungi:

```python
extracted_data = json.loads(response.content[0].text)  # o simile
print(f"Extracted data: {extracted_data}")
print(f"Date from invoice: {extracted_data.get('date')}")
```

#### Modifica 2: Aggiungi fallback per exchange rate

Nella funzione che ottiene i tassi di cambio, modifica così:

```python
# PRIMA:
response = dynamodb_client.get_item(...)
rate = response['Item']['usd_eur_rate']
return rate

# DOPO:
try:
    response = dynamodb_client.get_item(...)
    rate = response['Item']['usd_eur_rate']
    return rate
except Exception as e:
    print(f"Error getting exchange rate: {e}")
    print("Using default rate: 0.95")
    return 0.95
```

### Step 3: Redeploy la Lambda

```bash
chmod +x 5-deploy-lambda.sh
./5-deploy-lambda.sh
```

Questo:
- ✅ Crea un package ZIP con il codice modificato
- ✅ Carica il package su AWS Lambda
- ✅ Aggiorna la funzione

## 🧪 Test

Dopo il deploy, testa la Lambda:

```bash
# Carica un PDF di test
aws s3 cp test.pdf s3://fattura24-automation-pdfs-427910993269/input/test.pdf

# Monitora i log
aws logs tail /aws/lambda/fattura24-automation-process_pdf --since 1m --follow
```

Dovresti vedere nei log:
```
Extracted data: {...}
Date from invoice: 2025-11-09
Using default rate: 0.95  # Se il tasso non è in DynamoDB
```

## 📁 File Creati

- `lambda-code/` - Directory con il codice scaricato
- `lambda-code/process_pdf.py.backup` - Backup del file originale
- `lambda-function.zip` - Package di deployment

## 🔄 Rollback

Se qualcosa va storto, puoi ripristinare il backup:

```bash
cd lambda-code
cp process_pdf.py.backup process_pdf.py
cd ..
./5-deploy-lambda.sh
```

## 💡 Note

- Il tasso di default 0.95 è approssimativo (USD → EUR)
- Puoi cambiare il tasso di default modificando `0.95` nello script
- Il logging extra ti aiuta a debuggare l'estrazione di Claude
- I backup sono creati automaticamente prima delle modifiche

## ❓ Troubleshooting

### Errore: "aws: command not found"
Assicurati di usare Git Bash, non PowerShell

### Errore: "python: command not found"
Prova con `python3` o aggiungi Python al PATH

### La modifica automatica non funziona
Modifica manualmente `lambda-code/process_pdf.py` seguendo le istruzioni sopra

### Errore durante il deploy
Verifica di avere i permessi AWS corretti:
```bash
aws lambda get-function --function-name fattura24-automation-process_pdf --region eu-central-1
```
