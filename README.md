# g-log backend

NestJS 12 + TypeORM 1 + MySQL 8. API 명세: https://pajama-parties.github.io/g-log_swagger/
DB 설계: 레포 루트의 `DB설계_ERD_v2.xlsx`

## 처음 한 번

```bash
cd backend
npm install
cp .env.example .env        # 비밀번호 등 값 채우기
npm run db:up               # 도커 MySQL 실행 (Docker Desktop 켜져 있어야 함)
npm run migration:run       # auth_db, service_db 테이블 생성
npm run start:dev           # http://localhost:3000
```

- 도커 MySQL은 **3307** 포트를 씁니다 (PC에 설치된 MySQL이 3306을 쓰는 경우와 겹치지 않게).
- 접속 정보: `127.0.0.1:3307`, 계정 `.env`의 `DB_USER` / `DB_PASSWORD` (Workbench·DBeaver 등으로 확인 가능)

## DB 구조

| 연결 | DB | 엔티티 위치 | 리포지토리 주입 |
|---|---|---|---|
| `auth` | `auth_db` (7개 테이블) | `src/database/schema/entities/auth` | `@InjectRepository(User, AUTH_CONNECTION)` |
| `default` | `service_db` (12개 테이블) | `src/database/schema/entities/service` | `@InjectRepository(Plant)` |

- 두 DB 사이(user_id, device_id)는 실제 FK가 없는 **논리 FK**입니다. 앱에서 존재 여부를 확인하세요.
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
- refresh 토큰은 `auth_db.refresh_tokens`에 SHA-256 해시로만 저장합니다.
- 카카오 콘솔에서 Client Secret을 켰다면 `.env`의 `KAKAO_CLIENT_SECRET`이 꼭 있어야 합니다(없으면 KOE010).
- 비밀번호: 8~64자, 영문+숫자. scrypt 해시로만 저장. 틀린 비밀번호와 없는 이메일은 같은 401.
- 로그인·가입·카카오 로그인은 같은 IP에서 1분에 `SIGN_IN_RATE_LIMIT`(기본 10)번까지 (넘으면 429). 나머지 API는 1분에 100번.
- 테스트: `npm run test:e2e` (도커 MySQL 필요, 카카오는 가짜로 대체)

## 테이블을 바꿀 때 (마이그레이션)

`synchronize`는 꺼져 있습니다. 엔티티를 고친 뒤:

```bash
npm run migration:generate:service -- src/database/schema/migrations/service/AddSomething
npm run migration:generate:auth    -- src/database/schema/migrations/auth/AddSomething
# 생성된 SQL을 읽어 보고
npm run migration:run
```

| 명령 | 설명 |
|---|---|
| `npm run migration:show` | 적용 여부 확인 |
| `npm run migration:revert:service` / `:auth` | 마지막 마이그레이션 되돌리기 |
| `npm run db:down` | MySQL 컨테이너 중지 (데이터 유지) |
| `npm run db:reset` | **데이터까지 전부 삭제** 후 새로 시작 → 다시 `migration:run` |

주의: TypeORM은 MySQL `CHECK` 제약을 자동으로 만들지 않습니다. `plants`의 기준값 CHECK는 `InitService` 마이그레이션에 직접 넣어 두었습니다.
