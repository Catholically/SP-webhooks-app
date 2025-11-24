#!/bin/bash

# Script to deploy modified Lambda function to AWS
# Compatible with Git Bash on Windows

set -e

echo "=========================================="
echo "Deploying Lambda Function"
echo "=========================================="

# Configuration
AWS_REGION="eu-central-1"
FUNCTION_NAME="fattura24-automation-process_pdf"
CODE_DIR="lambda-code"
ZIP_FILE="lambda-function.zip"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if code directory exists
if [ ! -d "$CODE_DIR" ]; then
    echo -e "${RED}❌ Error: $CODE_DIR not found!${NC}"
    echo "Please run './3-download-lambda.sh' first"
    exit 1
fi

# Check if process_pdf.py exists
if [ ! -f "$CODE_DIR/process_pdf.py" ]; then
    echo -e "${RED}❌ Error: process_pdf.py not found in $CODE_DIR${NC}"
    exit 1
fi

echo -e "${YELLOW}📦 Step 1: Creating deployment package...${NC}"

# Remove old ZIP if exists
rm -f "$ZIP_FILE"

# Create ZIP with Python
cat > create_lambda_zip.py << 'PYTHON_SCRIPT'
import zipfile
import os
from pathlib import Path

def create_zip(source_dir, output_file):
    print(f"Creating ZIP: {output_file}")
    with zipfile.ZipFile(output_file, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(source_dir):
            # Skip __pycache__ and backup files
            dirs[:] = [d for d in dirs if d != '__pycache__']

            for file in files:
                # Skip .pyc files and backups
                if file.endswith('.pyc') or file.endswith('.backup'):
                    continue

                file_path = os.path.join(root, file)
                # Add to ZIP with relative path from source_dir
                arcname = os.path.relpath(file_path, source_dir)
                zipf.write(file_path, arcname)
                print(f"  Added: {arcname}")

    size = os.path.getsize(output_file)
    size_kb = size / 1024
    print(f"✅ ZIP created: {size_kb:.2f} KB")

if __name__ == '__main__':
    create_zip('lambda-code', 'lambda-function.zip')
PYTHON_SCRIPT

python create_lambda_zip.py
rm create_lambda_zip.py

if [ ! -f "$ZIP_FILE" ]; then
    echo -e "${RED}❌ Error: Failed to create ZIP file${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Deployment package created${NC}"
echo ""

echo -e "${YELLOW}📤 Step 2: Uploading to AWS Lambda...${NC}"

# Update Lambda function code
aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$AWS_REGION" \
    > /dev/null

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Lambda function updated successfully!${NC}"
else
    echo -e "${RED}❌ Error updating Lambda function${NC}"
    exit 1
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo "=========================================="
echo ""
echo "📋 Summary:"
echo "   - Function: $FUNCTION_NAME"
echo "   - Region: $AWS_REGION"
echo ""
echo "🧪 Test your Lambda function:"
echo "   1. Upload a PDF to S3"
echo "   2. Check CloudWatch Logs for debug output"
echo ""
echo "View logs:"
echo "   aws logs tail /aws/lambda/$FUNCTION_NAME --since 1m --follow"
