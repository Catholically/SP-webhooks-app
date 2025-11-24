#!/bin/bash

# Script to download Lambda function code from AWS
# Compatible with Git Bash on Windows

set -e

echo "=========================================="
echo "Downloading Lambda Function Code"
echo "=========================================="

# Configuration
AWS_REGION="eu-central-1"
FUNCTION_NAME="fattura24-automation-process_pdf"
DOWNLOAD_DIR="lambda-code"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}📥 Step 1: Getting Lambda function download URL...${NC}"

# Get the download URL
DOWNLOAD_URL=$(aws lambda get-function \
    --function-name "$FUNCTION_NAME" \
    --region "$AWS_REGION" \
    --query 'Code.Location' \
    --output text)

if [ -z "$DOWNLOAD_URL" ]; then
    echo "❌ Error: Could not get download URL"
    exit 1
fi

echo -e "${GREEN}✅ Got download URL${NC}"

echo -e "${YELLOW}📥 Step 2: Downloading Lambda code...${NC}"

# Create download directory
rm -rf "$DOWNLOAD_DIR"
mkdir -p "$DOWNLOAD_DIR"
cd "$DOWNLOAD_DIR"

# Download the ZIP file
curl -L -o lambda-code.zip "$DOWNLOAD_URL"

echo -e "${YELLOW}📦 Step 3: Extracting code...${NC}"

# Extract the ZIP
unzip -q lambda-code.zip
rm lambda-code.zip

echo -e "${GREEN}✅ Lambda code downloaded and extracted!${NC}"
echo ""
echo "Location: $(pwd)"
echo ""
echo "Files:"
ls -la

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Download Complete!${NC}"
echo "=========================================="
echo ""
echo "Next: Edit process_pdf.py to add debug logging"
