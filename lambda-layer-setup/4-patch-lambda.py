#!/usr/bin/env python3
"""
Script to patch process_pdf.py with debug logging and fallback exchange rate
"""

import re
import sys
from pathlib import Path

def patch_process_pdf(file_path):
    """Add debug logging and fallback exchange rate to process_pdf.py"""

    print(f"📝 Reading {file_path}...")
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original_content = content
    modified = False

    # Pattern 1: Add logging after Claude extraction
    # Look for where extracted_data is assigned from Claude response
    patterns_to_log = [
        (r'(extracted_data\s*=\s*json\.loads\([^)]+\))',
         r'\1\n    print(f"Extracted data: {extracted_data}")\n    print(f"Date from invoice: {extracted_data.get(\'date\')}")'),
        (r'(extracted_data\s*=\s*response\.content\[0\]\.text)',
         r'\1\n    print(f"Extracted data: {extracted_data}")\n    if isinstance(extracted_data, dict):\n        print(f"Date from invoice: {extracted_data.get(\'date\')}")'),
    ]

    for pattern, replacement in patterns_to_log:
        if re.search(pattern, content):
            content = re.sub(pattern, replacement, content)
            modified = True
            print("✅ Added debug logging after extraction")
            break

    # Pattern 2: Add fallback to exchange rate function
    # Find the get_exchange_rate function or similar

    # Option A: Wrap the exchange rate lookup in try-except with fallback
    exchange_rate_patterns = [
        # Pattern for DynamoDB get_item call
        (r'(def get_exchange_rate[^:]+:.*?)(response\s*=\s*dynamodb_client\.get_item\([^)]+\).*?return\s+[^\n]+)',
         r'\1try:\n        \2\n    except Exception as e:\n        print(f"Error getting exchange rate: {e}")\n        print("Using default rate: 0.95")\n        return 0.95'),

        # Pattern for direct dynamodb access
        (r'(rate\s*=\s*response\[\'Item\'\]\[\'usd_eur_rate\'\])',
         r'try:\n        \1\n    except (KeyError, Exception) as e:\n        print(f"Error getting exchange rate: {e}")\n        print("Using default rate: 0.95")\n        rate = 0.95'),
    ]

    for pattern, replacement in exchange_rate_patterns:
        if re.search(pattern, content, re.DOTALL):
            content = re.sub(pattern, replacement, content, flags=re.DOTALL)
            modified = True
            print("✅ Added fallback exchange rate")
            break

    # If we couldn't find specific patterns, add a general try-except around exchange rate logic
    if not modified or 'Using default rate: 0.95' not in content:
        # Look for "Error getting exchange rate" message that already exists
        if re.search(r'Error getting exchange rate:', content):
            # Add default return after the error print
            content = re.sub(
                r'(print\(f"Error getting exchange rate: \{[^}]+\}"\))',
                r'\1\n        print("Using default rate: 0.95")\n        return 0.95',
                content
            )
            modified = True
            print("✅ Added fallback to existing error handler")

    if content == original_content:
        print("⚠️  Warning: No modifications made. Manual editing may be required.")
        print("\nPlease manually add:")
        print("\n1. After Claude extraction:")
        print('   print(f"Extracted data: {extracted_data}")')
        print('   print(f"Date from invoice: {extracted_data.get(\'date\')}")')
        print("\n2. In exchange rate function:")
        print('   except Exception as e:')
        print('       print(f"Error getting exchange rate: {e}")')
        print('       print("Using default rate: 0.95")')
        print('       return 0.95')
        return False

    # Write the modified content
    backup_path = file_path.with_suffix('.py.backup')
    print(f"💾 Creating backup: {backup_path}")
    with open(backup_path, 'w', encoding='utf-8') as f:
        f.write(original_content)

    print(f"💾 Writing modified file: {file_path}")
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print("✅ File patched successfully!")
    return True

if __name__ == '__main__':
    lambda_code_dir = Path('lambda-code')
    process_pdf_path = lambda_code_dir / 'process_pdf.py'

    if not process_pdf_path.exists():
        print(f"❌ Error: {process_pdf_path} not found!")
        print("Please run 3-download-lambda.sh first")
        sys.exit(1)

    success = patch_process_pdf(process_pdf_path)

    if success:
        print("\n" + "="*50)
        print("✅ Patching Complete!")
        print("="*50)
        print("\nNext: Run './5-deploy-lambda.sh' to upload the modified code")
    else:
        print("\n" + "="*50)
        print("⚠️  Manual editing required")
        print("="*50)
        print(f"\nPlease edit {process_pdf_path} manually and then run './5-deploy-lambda.sh'")
