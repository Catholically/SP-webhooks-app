#!/bin/bash

# Script to build AWS Lambda Layer with Python dependencies
# Compatible with Git Bash on Windows

set -e  # Exit on error

echo "=========================================="
echo "Building Lambda Layer with Dependencies"
echo "=========================================="

# Configuration
PYTHON_VERSION="3.11"  # Change this if your Lambda uses a different Python version
LAYER_NAME="fattura24-dependencies-layer"
LAYER_DIR="lambda-layer"
REQUIREMENTS_FILE="requirements.txt"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if requirements.txt exists
if [ ! -f "$REQUIREMENTS_FILE" ]; then
    echo "❌ Error: $REQUIREMENTS_FILE not found!"
    exit 1
fi

echo -e "${YELLOW}📦 Step 1: Creating layer directory structure...${NC}"
rm -rf "$LAYER_DIR"
mkdir -p "$LAYER_DIR/python"

echo -e "${YELLOW}📥 Step 2: Installing dependencies...${NC}"
echo "This may take a few minutes..."

# Install dependencies into the python directory
# The --platform and --only-binary flags ensure compatibility with Lambda's Linux environment
pip install -r "$REQUIREMENTS_FILE" \
    --target "$LAYER_DIR/python" \
    --platform manylinux2014_x86_64 \
    --only-binary=:all: \
    --python-version "$PYTHON_VERSION" \
    --implementation cp \
    2>&1 | tee install.log

# Alternative method if the above fails (for packages without prebuilt wheels):
# pip install -r "$REQUIREMENTS_FILE" --target "$LAYER_DIR/python"

echo -e "${YELLOW}🗑️  Step 3: Cleaning up unnecessary files...${NC}"
# Remove unnecessary files to reduce layer size
find "$LAYER_DIR/python" -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true
find "$LAYER_DIR/python" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$LAYER_DIR/python" -name "*.pyc" -delete 2>/dev/null || true
find "$LAYER_DIR/python" -name "*.dist-info" -type d -exec rm -rf {} + 2>/dev/null || true

echo -e "${YELLOW}📦 Step 4: Creating ZIP file...${NC}"
cd "$LAYER_DIR"
ZIP_FILE="../${LAYER_NAME}.zip"
rm -f "$ZIP_FILE"

# Create zip file
zip -r9 "$ZIP_FILE" python -x "*.pyc" "*__pycache__*" 2>&1 | grep -v "adding:" || true

cd ..

# Check if zip was created successfully
if [ -f "${LAYER_NAME}.zip" ]; then
    ZIP_SIZE=$(du -h "${LAYER_NAME}.zip" | cut -f1)
    echo -e "${GREEN}✅ Layer built successfully!${NC}"
    echo ""
    echo "📊 Layer Details:"
    echo "   - File: ${LAYER_NAME}.zip"
    echo "   - Size: $ZIP_SIZE"
    echo "   - Location: $(pwd)/${LAYER_NAME}.zip"
    echo ""
    echo -e "${GREEN}✅ Next step: Run './2-deploy-layer.sh' to publish to AWS${NC}"
else
    echo "❌ Error: Failed to create ZIP file"
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ Build Complete!"
echo "=========================================="
