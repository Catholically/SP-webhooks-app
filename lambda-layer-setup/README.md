# AWS Lambda Layer Setup per fattura24-automation

Questi script ti permettono di creare e deployare un Lambda Layer con tutte le dipendenze Python necessarie per le tue Lambda functions.

## 📋 Prerequisiti

1. **AWS CLI** installato e configurato
   - Download: https://aws.amazon.com/cli/
   - Configurazione: `aws configure`
   - Verifica: `aws sts get-caller-identity`

2. **Python 3.11** installato (o la versione che usi nelle tue Lambda)
   - Verifica: `python --version` o `python3 --version`

3. **Git Bash** (su Windows) o Bash shell su Linux/Mac

4. **pip** per installare le dipendenze Python
   - Verifica: `pip --version` o `pip3 --version`

5. **zip** utility (solitamente già installato su Git Bash)
   - Verifica: `zip --version`

## 🚀 Come Usare

### Step 1: Copia i file nel tuo progetto

Copia questi file nella root del tuo progetto `fattura24-automation`:
- `requirements.txt`
- `1-build-layer.sh`
- `2-deploy-layer.sh`
- `README.md` (opzionale)

### Step 2: Configurazione AWS

Assicurati di aver configurato AWS CLI con le credenziali corrette:

```bash
aws configure
```

Inserisci:
- AWS Access Key ID
- AWS Secret Access Key
- Default region: `eu-central-1`
- Default output format: `json`

Verifica la configurazione:
```bash
aws sts get-caller-identity
```

Dovresti vedere il tuo Account ID: `427910993269`

### Step 3: Build del Layer

Apri Git Bash nella directory del progetto ed esegui:

```bash
chmod +x 1-build-layer.sh
./1-build-layer.sh
```

Questo script:
- ✅ Crea la struttura di directory corretta per il Lambda Layer
- ✅ Installa tutte le dipendenze da `requirements.txt`
- ✅ Rimuove file non necessari per ridurre la dimensione
- ✅ Crea un file ZIP pronto per il deploy

**Output**: `fattura24-dependencies-layer.zip`

### Step 4: Deploy su AWS

Dopo aver creato il file ZIP, esegui:

```bash
chmod +x 2-deploy-layer.sh
./2-deploy-layer.sh
```

Questo script:
- ✅ Pubblica il Lambda Layer su AWS nella regione `eu-central-1`
- ✅ Aggiorna automaticamente entrambe le Lambda functions:
  - `fattura24-automation-process_pdf`
  - `fattura24-automation-create_fattura24`

## 📦 Dipendenze Incluse

Il layer include le seguenti librerie Python:

- **boto3** (v1.34.131) - AWS SDK per Python
- **anthropic** (v0.34.2) - Anthropic API client
- **requests** (v2.31.0) - HTTP library
- **python-dotenv** (v1.0.0) - Environment variables management
- **PyPDF2** (v3.0.1) - PDF manipulation

## 🔧 Troubleshooting

### Errore: "AWS CLI is not installed"
Installa AWS CLI: https://aws.amazon.com/cli/

### Errore: "AWS credentials are not configured"
Esegui `aws configure` e inserisci le tue credenziali

### Errore: "pip: command not found"
Su Windows/Git Bash, prova con `pip3` o assicurati che Python sia nel PATH

### Errore: "zip: command not found"
Su Windows, installa zip tramite Git Bash o usa 7-Zip e modifica lo script

### Errore: Building wheel failed
Alcune dipendenze potrebbero non avere prebuilt wheels. Modifica `1-build-layer.sh` rimuovendo le opzioni `--platform` e `--only-binary`:

```bash
pip install -r "$REQUIREMENTS_FILE" --target "$LAYER_DIR/python"
```

### Layer troppo grande (>50 MB)
Se il layer supera il limite di 50 MB per upload diretto, dovrai usare S3:

```bash
aws s3 cp fattura24-dependencies-layer.zip s3://your-bucket/
aws lambda publish-layer-version \
  --layer-name fattura24-dependencies-layer \
  --content S3Bucket=your-bucket,S3Key=fattura24-dependencies-layer.zip \
  --compatible-runtimes python3.11
```

## 📝 Note Importanti

1. **Versione Python**: Gli script usano Python 3.11. Se le tue Lambda usano una versione diversa, modifica la variabile `PYTHON_VERSION` in entrambi gli script.

2. **Compatibilità**: Le dipendenze vengono installate con la piattaforma `manylinux2014_x86_64` per compatibilità con l'ambiente Lambda di AWS.

3. **Aggiornamenti**: Per aggiornare le dipendenze, modifica `requirements.txt` e riesegui entrambi gli script. AWS creerà una nuova versione del layer.

4. **Costi**: Lambda Layers sono gratuiti per lo storage fino a 75 GB. Oltre questo limite, si applicano i costi S3.

## 🎯 Verifica Funzionamento

Dopo il deploy, puoi verificare che tutto funzioni:

1. **Nella AWS Console**:
   - Vai su Lambda > Layers
   - Cerca `fattura24-dependencies-layer`
   - Verifica che sia presente

2. **Nelle Lambda Functions**:
   - Vai su Lambda > Functions
   - Apri `fattura24-automation-process_pdf`
   - Nella sezione "Layers" dovresti vedere il layer collegato

3. **Test delle Lambda**:
   - Esegui un test delle tue Lambda functions
   - Verifica che gli import funzionino:
     ```python
     import boto3
     import anthropic
     import requests
     from dotenv import load_dotenv
     import PyPDF2
     ```

## 📚 Risorse Utili

- [AWS Lambda Layers](https://docs.aws.amazon.com/lambda/latest/dg/configuration-layers.html)
- [AWS CLI Reference](https://docs.aws.amazon.com/cli/latest/)
- [Python Package Index](https://pypi.org/)

## 💡 Suggerimenti

- Mantieni `requirements.txt` aggiornato con le versioni esatte delle dipendenze
- Testa sempre le Lambda dopo aver aggiornato il layer
- Considera di versionare il nome del layer per rollback facili (es: `fattura24-dependencies-v2`)
