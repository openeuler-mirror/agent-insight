#!/bin/bash
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# scripts/create_migration_package.sh

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
PACKAGE_NAME="migration_data_$TIMESTAMP"
mkdir -p "$PACKAGE_NAME/data"

echo "📦 Creating migration package: $PACKAGE_NAME"

# 1. Back up Database Safely
DB_NAME="witty_insight.db"
DB_PATH="data/$DB_NAME"
if [ -f "$DB_PATH" ]; then
    echo "   Running safe backup of SQLite database..."
    if command -v sqlite3 &> /dev/null; then
        sqlite3 "$DB_PATH" ".backup '$PACKAGE_NAME/data/$DB_NAME'"
    else
        echo "   ⚠️ sqlite3 command not found, falling back to direct copy."
        echo "   ⚠️ Recommended: Stop the application before running this script to ensure data consistency."
        cp "$DB_PATH" "$PACKAGE_NAME/data/"
    fi
    echo "   ✔ Database backed up to $PACKAGE_NAME/data/$DB_NAME"
else
    echo "   ❌ Database file not found at $DB_PATH!"
    rm -rf "$PACKAGE_NAME"
    exit 1
fi

# 2. Copy .env (Optional/Warning)
if [ -f ".env" ]; then
    echo "   ✔ Copying .env file (Contains secrets!)"
    cp ".env" "$PACKAGE_NAME/"
fi

# 3. Copy Prisma Schema (Critical for Prisma Client gen)
if [ -d "prisma" ]; then
    echo "   ✔ Copying Prisma schema"
    mkdir -p "$PACKAGE_NAME/prisma"
    cp -r prisma/* "$PACKAGE_NAME/prisma/"
fi

# 4. Create Restore Instructions
cat > "$PACKAGE_NAME/HOW_TO_RESTORE.txt" <<EOF
MIGRATION RESTORE INSTRUCTIONS
==============================

1. Pre-requisites:
   - Node.js installed on target server.
   - Project code (git clone) is present on target server.

2. Files in this package:
   - data/$DB_NAME: The database file (User data, Skills, Executions).
   - .env: Environment variables (Review before using).
   - prisma/: Database schema files.

3. Restore Steps:
   a. Stop the running application on the new server (e.g., pm2 stop all).
   
   b. Extract the package on the destination server:
      tar -xzf $PACKAGE_NAME.tar.gz
      cd $PACKAGE_NAME

   c. Copy database to the project's 'data/' folder:
      mkdir -p /path/to/your/project/data
      cp data/$DB_NAME /path/to/your/project/data/

   d. Ensure '.env' is correctly set up in project root.
      (Check if DATABASE_URL="file:../data/$DB_NAME" is set)
      cp .env /path/to/your/project/

   e. Regenerate Prisma Client (CRITICAL STEP):
      cd /path/to/your/project
      npm install
      npx prisma generate

   f. Restart the application.
      npm run dev  (or npm run start / pm2 start ...)

EOF

# 5. Compress
# Use COPYFILE_DISABLE=1 to prevent ._ resource fork files on macOS
# Use --no-xattrs to prevent macOS extended attributes (like provenance) from causing warnings on Linux
if tar --version | grep -q "bsdtar"; then
    # macOS usually uses bsdtar
    COPYFILE_DISABLE=1 tar --no-xattrs -czf "${PACKAGE_NAME}.tar.gz" "$PACKAGE_NAME"
else
    # GNU tar or other
    tar -czf "${PACKAGE_NAME}.tar.gz" "$PACKAGE_NAME"
fi
rm -rf "$PACKAGE_NAME"

echo ""
echo "✅ Migration package created: ${PACKAGE_NAME}.tar.gz"
echo "---------------------------------------------------"
echo "NEXT STEPS (Execute on OBJECTIVE SERVER):"
echo ""
echo "1. Transfer the file:"
echo "   scp ${PACKAGE_NAME}.tar.gz user@target-server:/path/to/project_root/"
echo ""
echo "2. Log in and extract:"
echo "   ssh user@target-server"
echo "   cd /path/to/project_root/"
echo "   tar -xzf ${PACKAGE_NAME}.tar.gz"
echo ""
echo "3. Restore data & environment:"
echo "   cd ${PACKAGE_NAME}"
echo "   # Stop app if running"
echo "   # Copy Database"
echo "   mkdir -p ../data"
echo "   cp data/$DB_NAME ../data/"
echo "   # Copy Config"
echo "   cp .env ../.env"
echo "   # Copy Schema (just in case code is old)"
echo "   cp -r prisma/* ../prisma/"
echo ""
echo "4. Rebuild Database Client (CRITICAL):"
echo "   cd .."
echo "   npm install"
echo "   npx prisma generate"
echo ""
echo "5. Start App:"
echo "   npm run dev"
echo "---------------------------------------------------"
