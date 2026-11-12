#!/bin/bash
# Runs once, on first initialization of an empty MySQL data volume.
# Creates the dedicated integration-test database `<MYSQL_DATABASE>_test` and grants the
# application user access to it, so integration tests never touch development data.
set -euo pipefail

TEST_DB="${MYSQL_DATABASE}_test"

MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
SQL

echo "Created test database ${TEST_DB}"
