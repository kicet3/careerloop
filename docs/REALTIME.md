# 알림 실시간 수신 (Supabase Realtime)

새 알림(이력서 초안 완료, 진단 완료 등)이 생기면 열려 있는 탭에 바로 표시합니다. Vercel 함수 연결을 계속 열어 두지 않습니다. 설정하지 않으면 지금처럼 새로고침하거나 알림 패널을 열 때만 새 알림을 받습니다. 이 경우에도 오류는 나지 않습니다.

## 동작 방식

1. 서버가 알림을 DB에 저장합니다(`src/lib/notifications/service.ts`의 `createNotification`).
2. 저장한 뒤 Supabase Realtime REST Broadcast로 비공개 채널 `notifications:<userId>`에 이벤트 `notification`을 보냅니다(`src/lib/notifications/realtime.ts`).
   - 내용에는 알림 id(`{ "id": "..." }`)만 넣습니다. 제목과 본문은 보내지 않습니다.
   - 시간 제한은 2초입니다. 보내기가 실패해도 알림 저장에는 영향이 없습니다.
3. 브라우저(앱 화면)는 `GET /api/notifications/realtime-token`에서 1시간짜리 Realtime 토큰을 받습니다.
   - 이 토큰의 클레임은 `sub = 내 userId`, `role = authenticated`입니다.
   - 브라우저는 이 토큰으로 자기 채널만 private 모드로 구독합니다(`src/components/notifications/realtime.ts`).
4. 이벤트를 받으면 브라우저는 기존 API(`GET /api/notifications`)로 새 알림을 받고 토스트를 띄웁니다.
5. 토큰은 만료 5분 전에 새로 받습니다. 네트워크로 끊긴 연결은 supabase-js가 다시 연결하고, 토큰 만료로 Supabase가 채널을 닫으면 앱이 새 토큰으로 다시 구독합니다. 다시 연결되면 그 사이에 놓친 알림을 한 번 받습니다. 토큰 API가 401·403·404(로그아웃·설정 없음)를 돌려주면 실시간 수신을 멈춥니다.

다른 사람의 채널은 구독할 수 없습니다. 아래 RLS 정책이 막습니다. 우리 앱은 Supabase Auth를 쓰지 않기 때문에 서버가 직접 토큰에 서명합니다.

## 필요한 환경 변수 (Vercel → Project → Settings → Environment Variables)

| 이름 | 값 | 어디서 찾나 | 노출 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Supabase 대시보드 상단 **Connect** 또는 Settings → API의 Project URL | 공개 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon 키(`eyJ…`) 또는 publishable 키(`sb_publishable_…`) | Settings → **API Keys** | 공개 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 키(`eyJ…`) 또는 secret 키(`sb_secret_…`) | Settings → **API Keys** | **서버 전용** |
| `SUPABASE_JWT_SECRET` | Legacy JWT secret | Settings → **JWT Keys** → Legacy JWT Secret 탭 | **서버 전용** |
| `SUPABASE_REALTIME_JWK` (선택, 권장) | 가져온 ES256 개인 키 JWK(한 줄 JSON) | 아래 "방법 B" | **서버 전용** |

- 같은 값을 다른 이름으로 넣어도 받습니다.
  - URL: `SUPABASE_URL`
  - 공개 키: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY`
  - 서버 키: `SUPABASE_SECRET_KEY`
- **URL, 공개 키, 서버 키, 서명 키(`SUPABASE_REALTIME_JWK` 또는 `SUPABASE_JWT_SECRET`) 네 가지가 모두 있어야 켜집니다.** 하나라도 없으면 토큰 API가 404를 돌려주고, 앱은 새로고침 방식으로 동작합니다.
- 서명 키는 `SUPABASE_REALTIME_JWK`가 있으면 그것(ES256)을 쓰고, 없으면 `SUPABASE_JWT_SECRET`(HS256)을 씁니다.
- 공개 키와 URL은 서버가 토큰 API 응답으로 브라우저에 전달합니다. 그래서 `NEXT_PUBLIC_` 값이 빌드에 박히지 않아도 됩니다(코드는 런타임 환경 변수를 읽습니다).
- 서버 키와 서명 키는 브라우저로 가지 않습니다.
- Supabase는 레거시 `anon`/`service_role` 키를 2026년 말까지 단계적으로 없앨 예정입니다. 가능하면 `sb_publishable_…`/`sb_secret_…` 키를 넣으세요. 같은 변수 이름에 넣어도 됩니다.
- 환경 변수를 바꾼 뒤에는 **Redeploy**해야 반영됩니다.

## 설정 순서

### 1. Realtime 설정 (이미 했다면 넘어갑니다)

1. Supabase 대시보드 → **Realtime** → **Settings**(`/dashboard/project/_/realtime/settings`)로 갑니다.
2. **Allow public access**를 **끕니다**. 이렇게 하면 private 채널만 쓸 수 있습니다.
3. **Save**를 누릅니다.

### 2. RLS 정책 만들기 (SQL Editor에서 한 번 실행)

Supabase 대시보드 → **SQL Editor** → New query에 아래 SQL을 붙여 넣고 **Run**을 누릅니다.

```sql
-- 알림 채널: 토큰의 sub(우리 userId)와 같은 topic만 받을 수 있다.
create policy "notifications: users receive own broadcast"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'notifications:' || (select auth.jwt() ->> 'sub')
);
```

- `auth.uid()`를 쓰지 마세요. 우리 사용자 id는 UUID가 아니라서 형 변환에서 실패합니다. 위 SQL처럼 `auth.jwt() ->> 'sub'`를 씁니다.
- **INSERT 정책은 만들지 않습니다.** 브라우저는 보내지 않고 받기만 합니다. 서버의 REST Broadcast는 service/secret 키를 쓰므로 RLS를 거치지 않습니다.
- `alter table realtime.messages enable row level security`는 실행하지 마세요. RLS는 이미 켜져 있고, 이 문장은 권한 오류(42501)를 냅니다.
- 이 SQL은 Prisma 마이그레이션에 넣지 않습니다. 로컬 Postgres와 테스트(PGlite)에는 `realtime` 스키마가 없기 때문입니다.
- 확인 쿼리:

  ```sql
  select policyname, cmd, roles from pg_policies where schemaname = 'realtime' and tablename = 'messages';
  ```

- 다시 만들어야 하면 먼저 지웁니다.

  ```sql
  drop policy if exists "notifications: users receive own broadcast" on realtime.messages;
  ```

### 3. 토큰 서명 키 정하기

우리 서버가 서명한 토큰을 Supabase가 받아들여야 합니다. Settings → **JWT Keys**(`/dashboard/project/_/settings/jwt`)에서 프로젝트 상태를 확인하고, 아래 둘 중 하나로 설정합니다.

#### 방법 A: 레거시 JWT secret 쓰기 (`SUPABASE_JWT_SECRET`만 있으면 됨)

다음 경우에 이 방법이 동작합니다.

- JWT Keys 화면에 **Legacy JWT Secret**이 있습니다.
- 그리고 아래 둘 중 하나에 해당합니다.
  - 아직 새 서명 키로 옮기지 않았습니다(legacy secret이 현재 키입니다).
  - 옮겼지만 legacy 키가 **Previously used** 상태로 남아 있고 **Revoked가 아닙니다**.

이미 넣은 `SUPABASE_JWT_SECRET`(Legacy JWT Secret 탭의 값)만으로 충분합니다. **추가 대시보드 작업은 없습니다.**

주의할 점이 있습니다.

- Supabase는 이 방식(HS256 공유 비밀)을 더 이상 권장하지 않습니다.
- legacy 키를 **Revoke**하면 실시간 알림이 꺼집니다(구독 실패 → 새로고침 방식으로 돌아갑니다).
- 장기적으로는 방법 B를 쓰세요.

#### 방법 B (권장): ES256 서명 키를 가져와서 쓰기 (`SUPABASE_REALTIME_JWK`)

새 프로젝트이거나 legacy secret을 revoke할 계획이라면 이 방법을 씁니다.

1. 로컬에서 키를 만듭니다. Supabase CLI가 필요합니다.

   ```bash
   supabase gen signing-key --algorithm ES256
   ```

   출력은 `kid`, `kty: "EC"`, `crv: "P-256"`, `d`, `x`, `y`가 있는 개인 키 JWK입니다. 이 값은 비밀입니다. 저장소에 커밋하지 마세요.
2. Supabase → Settings → **JWT Keys** → **Create standby key** → **Import an existing private key**를 고르고, 위 JWK를 붙여 넣어 대기(standby) 키로 만듭니다.
3. **Rotate keys**를 눌러 이 키를 **Current key**로 올립니다.
   - 대기 상태로만 두면 아직 신뢰하지 않습니다. 반드시 rotate까지 해야 합니다.
   - rotate하면 이전 키도 계속 신뢰합니다. 레거시 `anon`/`service_role` 키도 legacy secret을 revoke하지 않는 한 계속 동작합니다.
   - 우리 앱은 Supabase Auth를 쓰지 않으므로 rotate해도 로그인에는 영향이 없습니다.
4. Vercel에 `SUPABASE_REALTIME_JWK`를 추가합니다. 값은 위 JWK **전체를 한 줄 JSON**으로 넣습니다. 예: `{"kty":"EC","kid":"…","crv":"P-256","d":"…","x":"…","y":"…"}`
   - **키 객체 하나(`{...}`)만** 넣습니다. 출력이 배열(`[{...}]`)이나 `{"keys":[...]}`로 나왔다면 안의 객체 하나만 꺼내 넣으세요(원소가 하나뿐이면 코드가 알아서 꺼내 쓰지만, 둘 이상이면 기능이 꺼집니다).
   - 이 값이 있으면 `SUPABASE_JWT_SECRET`보다 먼저 씁니다.
   - 토큰 헤더의 `kid`가 가져온 키와 같아야 하며, 코드는 JWK의 `kid`를 그대로 씁니다.

### 4. 배포

Vercel에서 **Redeploy**합니다(환경 변수를 바꿨다면 반드시). 코드는 새 의존성 `@supabase/supabase-js`를 씁니다. 로컬 개발 서버를 켜 둔 상태에서 `npm install`했다면 개발 서버를 다시 시작하세요.

### 5. 확인

1. 로그인한 상태로 앱(`/app/...`)을 엽니다.
2. 브라우저 개발자 도구 → Network에서 아래를 확인합니다.
   - `GET /api/notifications/realtime-token`이 **200**이어야 합니다. 404는 환경 변수가 빠졌다는 뜻입니다.
   - `wss://<project-ref>.supabase.co/realtime/v1/websocket?...` 연결이 있어야 합니다.
3. WebSocket 메시지에서 `phx_join` 뒤 `phx_reply`가 `"status":"ok"`인지 봅니다.
4. 이력서 초안 생성 같은 백그라운드 작업을 실행하고 다른 화면에 있으면, 끝날 때 새로고침 없이 오른쪽 아래에 토스트가 뜨고 배지가 늘어야 합니다.
5. 서버 쪽만 따로 확인하려면 터미널에서 직접 보낼 수 있습니다(`<...>`는 실제 값으로 바꾸세요). 앱이 열려 있으면 알림 목록을 한 번 다시 받습니다. 이 id의 알림이 없어도 목록만 다시 받으므로 해가 없습니다.

   ```bash
   curl -i -X POST 'https://<project-ref>.supabase.co/realtime/v1/api/broadcast' \
     -H 'apikey: <SUPABASE_SERVICE_ROLE_KEY 값>' \
     -H 'Content-Type: application/json' \
     --data '{"messages":[{"topic":"notifications:<내 userId>","event":"notification","payload":{"id":"test"},"private":true}]}'
   ```

   - 응답은 `202 Accepted`여야 합니다.
   - 레거시 `service_role` 키(`eyJ…`)라면 `-H 'Authorization: Bearer <같은 키>'`도 붙입니다.

## 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `realtime-token`이 404 | 네 가지 환경 변수 중 하나가 없거나 잘못됐습니다. `SUPABASE_REALTIME_JWK`가 깨진 JSON이거나 `kid`가 없어도 꺼집니다(Vercel 함수 로그에 `[realtime]`이 남습니다). 값을 고친 뒤 Redeploy하세요. |
| 웹소켓은 열리는데 `phx_reply`가 `error`이고 `Unauthorized` 등이 나옴, 토스트가 안 뜸 | (1) 2단계 RLS 정책이 없습니다. SQL을 실행하세요. (2) Supabase가 토큰 서명을 받아들이지 않습니다. 방법 A라면 legacy secret이 revoke됐거나 값이 틀린 경우입니다. 방법 B라면 가져온 키를 rotate하지 않았거나 Vercel의 JWK가 가져온 키와 다른 경우입니다. 처음 구독이 3번 실패하면 앱은 조용히 연결을 닫고 새로고침 방식으로 돌아갑니다. |
| `invalid JWT` / `signature` 관련 오류 | `SUPABASE_JWT_SECRET`은 JWT Keys 화면의 **Legacy JWT Secret** 값이어야 합니다. anon 키나 service_role 키가 아닙니다. 앞뒤 공백도 확인하세요. |
| 구독은 되는데 이벤트가 안 옴 | 서버가 보내지 못했을 수 있습니다. Vercel 함수 로그에서 `[realtime] broadcast 실패 401/403`을 찾아보세요. 이 경우 `SUPABASE_SERVICE_ROLE_KEY`가 틀린 것입니다(publishable/anon 키를 넣으면 안 됩니다). curl로 5단계를 시험해 보세요. topic은 `notifications:<userId>`이고, `"private": true`가 있어야 private 구독자에게 전달됩니다. |
| 1시간쯤 뒤 끊김 | 토큰 갱신이 실패했습니다. `realtime-token`이 401·403·404(로그아웃·설정 없음)면 앱은 실시간 수신을 멈추고 더 부르지 않습니다 — 다시 로그인하고 새로고침하세요. 429·5xx·네트워크 오류면 1분→2분→…최대 15분 간격으로 다시 받고, 토큰 만료로 Supabase가 채널을 닫으면 새 토큰을 받은 뒤 다시 구독합니다(연속 5번까지). 다시 구독되면 놓친 알림을 한 번 받아 옵니다. 그래도 안 되면 새로고침하세요. |
| 로컬 개발에서 동작 안 함 | 로컬 `.env.local`에 위 변수가 없으면 꺼진 상태가 정상입니다. 로컬에서 시험하려면 같은 값을 `.env.local`에 넣고 개발 서버를 다시 시작하세요. 로컬 DB에서 만든 알림 id는 운영 Supabase Realtime으로도 보내집니다. 내용은 id뿐입니다. |
| 다른 사용자의 알림을 받을까 걱정 | 토큰의 `sub`는 서버가 세션으로 정합니다. RLS는 `notifications:` + `sub` topic만 허용합니다. 신호에는 id만 들어 있고, 실제 내용은 세션 인증을 거친 `GET /api/notifications`가 내 것만 돌려줍니다. |

## 끄기

Vercel에서 서명 키 변수(`SUPABASE_JWT_SECRET`, `SUPABASE_REALTIME_JWK` — 넣은 것 모두)를 지우고 Redeploy하면 실시간 수신이 꺼집니다. 기존의 새로고침과 패널 열기 방식은 그대로 동작합니다.
