#!/bin/bash

# Script to publish Lambda Layer to AWS and update Lambda functions
# Compatible with Git Bash on Windows

set -e  # Exit on error

echo "=========================================="
echo "Publishing Lambda Layer to AWS"
echo "=========================================="

# Configuration
AWS_REGION="eu-central-1"
AWS_ACCOUNT="427910993269"
LAYER_NAME="fattura24-dependencies-layer"
ZIP_FILE="${LAYER_NAME}.zip"
PYTHON_VERSION="python3.11"  # Must match the Python version used in build script

# Lambda functions to update
LAMBDA_FUNCTIONS=(
    "fattura24-automation-process_pdf"
    "fattura24-automation-create_fattura24"
)

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ Error: AWS CLI is not installed or not in PATH${NC}"
    echo "Please install AWS CLI: https://aws.amazon.com/cli/"
    exit 1
fi

# Check if ZIP file exists
if [ ! -f "$ZIP_FILE" ]; then
    echo -e "${RED}❌ Error: $ZIP_FILE not found!${NC}"
    echo "Please run './1-build-layer.sh' first to create the layer package."
    exit 1
fi

# Check AWS credentials
echo -e "${YELLOW}🔐 Checking AWS credentials...${NC}"
if ! aws sts get-caller-identity --region "$AWS_REGION" &> /dev/null; then
    echo -e "${RED}❌ Error: AWS credentials are not configured or invalid${NC}"
    echo "Please configure AWS CLI with: aws configure"
    exit 1
fi

CALLER_IDENTITY=$(aws sts get-caller-identity --region "$AWS_REGION")
CURRENT_ACCOUNT=$(echo "$CALLER_IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)

echo -e "${GREEN}✅ Authenticated as:${NC}"
echo "$CALLER_IDENTITY" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4
echo ""

if [ "$CURRENT_ACCOUNT" != "$AWS_ACCOUNT" ]; then
    echo -e "${YELLOW}⚠️  Warning: Current account ($CURRENT_ACCOUNT) differs from expected ($AWS_ACCOUNT)${NC}"
    read -p "Do you want to continue? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Deployment cancelled."
        exit 1
    fi
fi

echo -e "${YELLOW}📤 Step 1: Publishing Lambda Layer...${NC}"
echo "Layer name: $LAYER_NAME"
echo "Region: $AWS_REGION"
echo ""

# Publish the layer
LAYER_OUTPUT=$(aws lambda publish-layer-version \
    --layer-name "$LAYER_NAME" \
    --description "Python dependencies for fattura24-automation: boto3, anthropic, requests, python-dotenv, PyPDF2" \
    --zip-file "fileb://$ZIP_FILE" \
    --compatible-runtimes "$PYTHON_VERSION" \
    --region "$AWS_REGION" \
    2>&1)

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error publishing layer:${NC}"
    echo "$LAYER_OUTPUT"
    exit 1
fi

# Extract Layer ARN and Version
LAYER_ARN=$(echo "$LAYER_OUTPUT" | grep -o '"LayerVersionArn": "[^"]*"' | cut -d'"' -f4)
LAYER_VERSION=$(echo "$LAYER_OUTPUT" | grep -o '"Version": [0-9]*' | grep -o '[0-9]*')

echo -e "${GREEN}✅ Layer published successfully!${NC}"
echo "   - Layer ARN: $LAYER_ARN"
echo "   - Version: $LAYER_VERSION"
echo ""

echo -e "${YELLOW}🔄 Step 2: Updating Lambda functions...${NC}"
echo ""

# Update each Lambda function
for FUNCTION_NAME in "${LAMBDA_FUNCTIONS[@]}"; do
    echo "Updating: $FUNCTION_NAME"

    # Check if function exists
    if ! aws lambda get-function --function-name "$FUNCTION_NAME" --region "$AWS_REGION" &> /dev/null; then
        echo -e "${RED}   ❌ Function $FUNCTION_NAME not found in region $AWS_REGION${NC}"
        continue
    fi

    # Update function configuration to use the layer
    UPDATE_OUTPUT=$(aws lambda update-function-configuration \
        --function-name "$FUNCTION_NAME" \
        --layers "$LAYER_ARN" \
        --region "$AWS_REGION" \
        2>&1)

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}   ✅ Updated successfully${NC}"
    else
        echo -e "${RED}   ❌ Error updating function:${NC}"
        echo "$UPDATE_OUTPUT"
    fi
    echo ""
done

echo "=========================================="
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo "=========================================="
echo ""
echo "📋 Summary:"
echo "   - Layer: $LAYER_NAME (v$LAYER_VERSION)"
echo "   - ARN: $LAYER_ARN"
echo "   - Region: $AWS_REGION"
echo ""
echo "Your Lambda functions now have access to:"
echo "   - boto3 (v1.34.131)"
echo "   - anthropic (v0.34.2)"
echo "   - requests (v2.31.0)"
echo "   - python-dotenv (v1.0.0)"
echo "   - PyPDF2 (v3.0.1)"
echo ""
echo -e "${GREEN}🎉 You can now test your Lambda functions!${NC}"
