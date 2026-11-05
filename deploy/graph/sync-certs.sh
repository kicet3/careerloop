#!/usr/bin/env bash
# Let's Encrypt 인증서(graph.example.com)를 Neo4j가 읽을 수 있는 위치로 복사하고, 바뀌었으면 Neo4j를 재시작한다.
# 인증서 갱신(certbot renew) 뒤에도 다시 실행한다.
set -euo pipefail
cd "$(dirname "$0")"
LIVE="${LE_LIVE_DIR:-/path/to/edge-proxy/infra/certbot/conf/live/graph.example.com}"
mkdir -p certs/bolt
changed=0
# live/는 archive/로 가는 심볼릭 링크라 -L로 실제 파일을 복사한다.
if ! cmp -s "$LIVE/fullchain.pem" certs/bolt/public.crt 2>/dev/null; then cp -L "$LIVE/fullchain.pem" certs/bolt/public.crt; changed=1; fi
if ! cmp -s "$LIVE/privkey.pem" certs/bolt/private.key 2>/dev/null; then cp -L "$LIVE/privkey.pem" certs/bolt/private.key; changed=1; fi
chmod 644 certs/bolt/public.crt
chmod 644 certs/bolt/private.key # 컨테이너의 neo4j 사용자가 읽어야 한다. 폴더(certs/)는 git 제외.
if [ "$changed" = 1 ] && docker ps --format '{{.Names}}' | grep -qx careerloop-graph; then
  docker compose -p careerloop-graph -f docker-compose.yml -f docker-compose.tls.yml $([ -n "${PUBLIC:-}" ] && echo "-f docker-compose.public.yml") up -d --force-recreate
fi
echo "인증서 동기화 완료 (changed=$changed)"
