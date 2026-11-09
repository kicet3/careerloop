# 운영 AI 워커 (FastAPI @ Mac mini)

Vercel 함수 시간 상한(300초)에 걸리는 장시간 AI 작업을 맥미니에서 실행하는 워커입니다. 설계는 `docs/PYTHON-WORKER.md`, 코드는 `worker/`입니다.

| 항목 | 값 |
|---|---|
| 컨테이너 | `careerloop-worker` (`127.0.0.1:8090`, 네트워크 `cbt_bank_default`) |
| 공개 주소 | `https://<연결한 도메인>` (cbt-nginx 443 → careerloop-worker:8090) |
| 공개 경로 | `GET /healthz` 하나. `/readyz`·`/v1/jobs/*`는 HMAC 서명이 필요합니다 |
| 비밀값 | `deploy/worker/.env` (권한 600, git 제외). 이름은 `.env.example` |

아래 명령의 `resume-api.example.com`은 예시입니다. 실제로 연결한 도메인으로 바꿔 쓰세요.

## 1. DNS

1. A 레코드: `resume-api.example.com` → 맥미니 공인 IP(`graph.example.com`과 같은 IP).
2. **Cloudflare 프록시는 끈 채로(DNS only) 둡니다.** nginx 속도 제한이 클라이언트 IP 기준이라, 프록시를 켜면 모든 요청이 Cloudflare IP 몇 개로 보여 서명 없는 요청만으로 Vercel 디스패치가 429로 막힐 수 있습니다. 꼭 켜야 하면 `nginx-worker.conf`의 real_ip 주석(Cloudflare 대역 전부 + `real_ip_header CF-Connecting-IP`)을 채우고 SSL 모드를 `Full (strict)`로 둡니다.
3. 확인:
   ```sh
   dig +short resume-api.example.com
   ```

공유기의 80·443 포트 포워딩은 cbt-nginx가 이미 쓰고 있으므로 그대로 둡니다.

## 2. nginx 서버 블록 넣기 (HTTP만 먼저)

1. 백업합니다.
   ```sh
   N=/path/to/edge-proxy/infra/nginx.conf
   cp $N $N.before-careerloop-worker-$(date +%Y%m%d-%H%M%S)
   ```
2. 도메인을 바꾼 블록을 만듭니다.
   ```sh
   cd /path/to/careerloop/deploy/worker
   sed 's/WORKER_DOMAIN/resume-api.example.com/g' nginx-worker.conf > /tmp/nginx-worker.conf
   ```
3. 인증서가 아직 없으므로 처음에는 **80 서버 블록(acme-challenge)만** 붙입니다. `/tmp/nginx-worker.conf`의 `limit_req_zone`, `upstream`, `listen 80` 블록을 `$N`의 `http { }` 블록 안 마지막 `}` 바로 위에 붙입니다. 443 블록은 3단계 뒤에 붙입니다.
4. 문법을 확인하고 다시 읽습니다.
   ```sh
   docker exec cbt-nginx nginx -t && docker exec cbt-nginx nginx -s reload
   ```

## 3. 인증서 발급 (graph.example.com과 같은 certbot 폴더)

```sh
C=/path/to/edge-proxy/infra/certbot
docker run --rm -v $C/conf:/etc/letsencrypt -v $C/www:/var/www/certbot certbot/certbot \
  certonly --webroot -w /var/www/certbot -d resume-api.example.com --agree-tos --no-eff-email -m <관리자 이메일>
ls $C/conf/live/resume-api.example.com/
```

발급되면 `/tmp/nginx-worker.conf`의 `listen 443` 블록도 `$N`에 붙이고 다시 읽습니다.

```sh
docker exec cbt-nginx nginx -t && docker exec cbt-nginx nginx -s reload
```

갱신은 graph와 같습니다(`renew`가 모든 도메인을 함께 갱신합니다).

```sh
C=/path/to/edge-proxy/infra/certbot; docker run --rm -v $C/conf:/etc/letsencrypt -v $C/www:/var/www/certbot certbot/certbot renew
docker exec cbt-nginx nginx -s reload
```

## 4. 비밀값

```sh
cd /path/to/careerloop/deploy/worker
cp .env.example .env && chmod 600 .env
openssl rand -hex 32   # WORKER_SHARED_SECRET — Vercel에도 같은 값을 넣는다
```

`.env`에 채울 값(설명은 `docs/PYTHON-WORKER.md` §6):

- `WORKER_SHARED_SECRET`: 위에서 만든 값(32자 미만이면 워커가 시작하지 않습니다).
- `DATABASE_URL`: Supabase **세션 풀러(5432) 또는 direct** 주소 + `?sslmode=require`.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`(선택), `R2_*`: Vercel과 같은 값.
- `NEO4J_URI=bolt+s://graph.example.com:7697`, `NEO4J_USER`, `NEO4J_PASSWORD`.
- `APP_ENV=PRODUCTION`, `WORKER_CONCURRENCY=4`. `WORKER_QUEUE_BACKLOG`은 기본 0입니다. 빈 자리가 없으면 503을 돌려 Vercel이 바로 실행합니다.
- `WORKER_JOBS`: 비우면 `*`(등록된 종류 전부). 워커 쪽에서 받는 종류를 줄일 때만 씁니다.

## 5. 빌드·실행

```sh
cd /path/to/careerloop/deploy/worker
docker compose -p careerloop-worker up -d --build
docker compose -p careerloop-worker ps        # STATUS가 healthy인지
docker logs --tail 50 careerloop-worker       # worker_start 줄 확인
```

`cbt_bank_default` 네트워크가 없다는 오류가 나면 cbt_bank 스택(cbt-nginx)이 떠 있는지 먼저 확인합니다.

## 6. 확인

```sh
# 맥미니 안에서
curl -i http://127.0.0.1:8090/healthz                 # 204
# 밖에서(nginx·인증서 경유)
curl -i https://resume-api.example.com/healthz      # 204
curl -i https://resume-api.example.com/readyz       # 401(서명 없음) — 정상
```

서명한 `/readyz`(DB·Neo4j 연결 확인)는 저장소 루트에서 다음처럼 부릅니다(비밀값은 셸 변수로만 씁니다).

```sh
cd /path/to/careerloop/worker
WORKER_SHARED_SECRET=$(grep ^WORKER_SHARED_SECRET= ../deploy/worker/.env | cut -d= -f2-) uv run python - <<'PY'
import os, urllib.request
from app.security.signing import signed_headers
h = signed_headers(os.environ["WORKER_SHARED_SECRET"], "GET", "/readyz", b"")
req = urllib.request.Request("https://resume-api.example.com/readyz", headers=h)
print(urllib.request.urlopen(req, timeout=10).read().decode())
PY
```

`{"ok": true, "db": "ok", "neo4j": "ok", ...}`가 나오면 됩니다.

## 7. Vercel 켜기

Vercel Production 환경 변수:

| 이름 | 값 |
|---|---|
| `WORKER_URL` | `https://resume-api.example.com` (경로 없이) |
| `WORKER_SHARED_SECRET` | `.env`와 같은 값 |
| `WORKER_JOBS` | 처음에는 한 종류만(예: `resume-draft`). 확인한 뒤 늘리거나 `*` |

끄려면 `WORKER_JOBS`를 비우거나 `WORKER_URL`을 지우고 다시 배포합니다. 그러면 모든 작업이 원래대로 Vercel `after()`에서 실행됩니다.
워커가 꺼져 있거나 5초 안에 202를 주지 않아도 Vercel이 직접 실행합니다.

## 운영 메모

- 업데이트: `git pull` 뒤 `docker compose -p careerloop-worker up -d --build`. 실행 중이던 작업은 끊기고, 화면의 다시 시도로 이어서 할 수 있습니다.
- 로그에는 작업 id·kind·걸린 시간만 남습니다(이력서·JD·프롬프트 본문은 남기지 않습니다).
- 컨테이너는 uid 10001(root 아님), 읽기 전용 파일 시스템, 모든 capability 제거로 실행됩니다.
