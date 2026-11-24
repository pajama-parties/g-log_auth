#!/bin/bash
# 컨테이너를 처음 만들 때(데이터 볼륨이 비어 있을 때) 한 번만 실행됩니다.
# auth_db, service_db 를 만들고 앱 계정(DB_USER)에 두 DB 권한만 줍니다.
set -e
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`${AUTH_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS \`${SERVICE_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON \`${AUTH_DB_NAME}\`.* TO '${MYSQL_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${SERVICE_DB_NAME}\`.* TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
SQL
