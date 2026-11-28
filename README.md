# g-log backend

NestJS 12 + TypeORM 1 + PostgreSQL 17. API 명세: https://pajama-parties.github.io/g-log_swagger/
DB 설계: 레포 루트의 `DB설계_ERD_v2.xlsx`

## 처음 한 번

```bash
cd backend
npm install
cp .env.example .env        # 비밀번호 등 값 채우기
npm run db:up               # 도커 PostgreSQL 실행 (Docker Desktop 켜져 있어야 함)
npm run migration:run       # auth·service 스키마와 테이블 생성
npm run start:dev           # http://localhost:3000
```

- 도커 PostgreSQL은 **5433** 포트를 씁니다 (PC에 설치된 PostgreSQL이 5432를 쓰는 경우와 겹치지 않게).
- 접속 정보: `127.0.0.1:5433`, DB `.env`의 `DB_NAME`, 계정 `DB_USER` / `DB_PASSWORD` (DBeaver·pgAdmin 등으로 확인 가능)

## 도커로 전체 스택 실행

서버를 직접 실행하지 않고 PostgreSQL, 마이그레이션, auth 서버(3000번 포트), 서비스 API(3001번 포트)를 모두 도커로 띄울 수 있습니다. 서비스 API는 옆 폴더의 `../g-log_web_API`를 빌드하므로, 두 레포를 같은 폴더 아래에 받아 두고 두 레포 모두 Entity 서브모듈(`src/database/schema`, 엔티티와 마이그레이션)을 받아 둬야 합니다. 아래 명령은 `g-log_auth` 폴더에서 실행합니다.

```bash
git submodule update --init                    # g-log_auth, g-log_web_API 양쪽에서
cp .env.example .env                           # .env가 없을 때만 (값 채우기)
npm run stack:up                               # 이미지 빌드 → 마이그레이션 → 서버 2개 실행
                                               # 확인: http://localhost:3000/api/docs, http://localhost:3001/api/docs
npm run stack:logs                             # 서버 로그
npm run stack:down                             # 전체 중지 (데이터 유지)
```

- 두 서버는 이 레포의 `.env` 하나를 함께 씁니다. 그래서 `JWT_ACCESS_SECRET`과 DB 접속 정보가 항상 같습니다.
- `.env`의 `DB_HOST`·`DB_PORT`는 PC에서 DB에 접속할 때 쓰는 값입니다. 컨테이너 안에서는 `postgres:5432`로 접속하도록 `docker-compose.yml`에서 바꿔 넣습니다.
- `stack:up`을 실행할 때마다 `docker-compose.yml`의 `migrate` 서비스가 `npm run migration:run`과 같은 마이그레이션을 실행하고, 성공해야 두 서버가 시작합니다. 실패하면 `docker compose logs migrate`로 원인을 확인합니다.
- 커뮤니티 사진은 도커 볼륨 `glog-uploads`에 저장되고, `stack:down` 후에도 남습니다. DB와 사진까지 모두 지우려면 `docker compose --profile app down -v`를 실행합니다.
- 코드를 고친 뒤에는 `npm run stack:up`을 다시 실행하면 이미지를 새로 빌드합니다.

## DB 구조

PostgreSQL DB 하나(`DB_NAME`)를 스키마 두 개로 나눠 쓰고, 연결은 하나입니다. 서비스에서는 `@InjectDataSource() db: DataSource`로 받아 두 스키마의 엔티티를 함께 다룹니다.

| 스키마 | 테이블 | 엔티티 위치 |
|---|---|---|
| `auth` | 계정·토큰 (7개) | `src/database/schema/entities/auth` |
| `service` | 화분·센서·알림·조언·커뮤니티 (12개) | `src/database/schema/entities/service` |

- 두 스키마 사이에도 실제 FK가 있습니다: `service.user_profiles.user_id` → `auth.users`, `auth.device_credentials.device_id` → `service.devices`.
- 연결이 하나라서 두 스키마를 바꾸는 작업은 트랜잭션 하나로 묶습니다. 가입할 때 계정과 프로필을 함께 만들고, 탈퇴할 때 계정과 서비스 데이터를 함께 정리합니다.
- 코드값(OK/DRY/WET 등)은 `src/database/schema/enums.ts`. 화면 문구로 바꾸는 표는 설계 엑셀 개요 9번.
- 시간은 모두 UTC로 저장합니다.

## API 문서 (스웨거)

서버를 켜고 **http://localhost:3000/api/docs** — 코드에서 자동 생성되므로 항상 실제 동작과 같습니다. (JSON: `/api/docs-json`)
입력 검사는 Zod 스키마(`*.schemas.ts`)로 하고, 같은 스키마가 문서에 그대로 나옵니다.

## 인증 (카카오·이메일 로그인 + JWT)

모든 API는 기본으로 **로그인 필요**입니다(전역 가드). 열어 둘 곳만 `@Public()`. 컨트롤러에서 사용자는 `@CurrentUser() user: User`.

| 주소 | 설명 |
|---|---|
| `GET /auth/kakao` | (개발용) 브라우저로 열면 카카오 로그인 → 콜백 → 쿠키 발급 |
| `GET /auth/kakao/callback` | 카카오 콘솔에 등록한 Redirect URI |
| `POST /api/auth/signup` `{ email, password, name }` | 이메일 가입 → 바로 로그인 (201, 중복 409) |
| `POST /api/auth/login` `{ email, password }` | 이메일 로그인 |
| `POST /api/auth/kakao` `{ code }` | 프런트가 받은 인가 코드로 로그인 (스웨거) |
| `POST /api/auth/refresh` | access 토큰 재발급. 401이면 다시 로그인 |
| `POST /api/auth/logout` | 로그아웃 (204) |
| `GET /api/me` | 내 정보 (로그인 필요) |
| `PATCH /api/me` `{ name?, kakaoConsent? }` | 닉네임·카카오톡 동의 변경 |
| `DELETE /api/me` `{ confirm: "삭제" }` | 탈퇴 |

- 토큰은 **HttpOnly 쿠키**로 내려갑니다: `access_token`(15분, 모든 경로), `refresh_token`(14일, `/api/auth` 경로만).
  - 프런트는 `fetch(..., { credentials: 'include' })`만 쓰면 되고 토큰을 직접 다루지 않습니다.
  - API가 401이면 `POST /api/auth/refresh` 한 번 → 원래 요청 재시도 → 또 401이면 로그인 화면.
- Postman 등에서는 `Authorization: Bearer <access_token>` 헤더도 됩니다.
- refresh 토큰은 한 번 쓰면 새 것으로 바뀝니다. 이미 쓴 토큰이 다시 오면(탈취 의심) 그 로그인 전체가 끊깁니다.
- refresh 토큰은 `auth.refresh_tokens`에 SHA-256 해시로만 저장합니다.
- 카카오 콘솔에서 Client Secret을 켰다면 `.env`의 `KAKAO_CLIENT_SECRET`이 꼭 있어야 합니다(없으면 KOE010).
- 비밀번호: 8~64자, 영문+숫자. scrypt 해시로만 저장. 틀린 비밀번호와 없는 이메일은 같은 401.
- 로그인·가입·카카오 로그인은 같은 IP에서 1분에 `SIGN_IN_RATE_LIMIT`(기본 10)번까지 (넘으면 429). 나머지 API는 1분에 100번.
- 테스트: `npm run test:e2e` (도커 PostgreSQL과 `migration:run` 필요, 카카오는 가짜로 대체)

## 테이블을 바꿀 때 (마이그레이션)

`synchronize`는 꺼져 있습니다. 엔티티를 고친 뒤:

```bash
npm run migration:generate -- src/database/schema/migrations/AddSomething
# 생성된 SQL을 읽어 보고
npm run migration:run
```

| 명령 | 설명 |
|---|---|
| `npm run migration:show` | 적용 여부 확인 |
| `npm run migration:revert` | 마지막 마이그레이션 되돌리기 |
| `npm run db:down` | PostgreSQL 컨테이너 중지 (데이터 유지) |
| `npm run db:reset` | **데이터까지 전부 삭제** 후 새로 시작 → 다시 `migration:run` |

주의: 마이그레이션 생성기는 여러 테이블이 함께 쓰는 enum 타입(예: `service.moisture_status`)을 중복으로 만들 수 있습니다. 생성된 SQL에서 `CREATE TYPE`·`DROP TYPE`이 두 번 나오지 않는지 확인하세요.
