# 운영 그래프 서버 (Neo4j @ graph.example.com)

> 이 문서의 `graph.example.com`·IP·경로는 자리표시자입니다. 실제 값은 저장소에 두지 않고 `deploy/graph/.env`(git 제외)에
> `NEO4J_PASSWORD`, `GRAPH_HOST=<도메인>`, `LE_LIVE_DIR=<certbot>/conf/live/<도메인>`으로 넣습니다. `nginx-graph.conf`의 도메인은 붙여 넣을 때 바꿉니다.

맥미니에서 띄우는 CareerLoop 운영용 Neo4j입니다. 개발용 Neo4j(루트 `docker-compose.yml`, 127.0.0.1:7687)와는 별개입니다.

| 용도 | 주소 |
|---|---|
| 앱(Vercel) Bolt 드라이버 | `bolt+s://graph.example.com:7697` (TLS 필수, nginx 거치지 않음) |
| Neo4j Browser | `https://graph.example.com` (cbt-nginx → careerloop-graph:7474, 웹소켓 Bolt → careerloop-graph:7687 TLS) |
| 계정 | `neo4j` / `deploy/graph/.env`의 `NEO4J_PASSWORD` (git 제외) |

DNS: `graph.example.com` A → 203.0.113.10 (Cloudflare, 프록시 끔 — Bolt TCP는 Cloudflare 프록시를 통과하지 못함).

## 현재 상태 (2026-11-06)

- 인증서 발급 완료(Let's Encrypt, `graph.example.com`). `./sync-certs.sh`로 `certs/bolt/`에 복사.
- `careerloop-graph`: Bolt TLS 필수로 동작, `cbt_bank_default` 네트워크에 연결. 호스트 포트는 아직 **127.0.0.1에만** 열려 있음.
- cbt-nginx에 `BEGIN/END CAREERLOOP GRAPH` 블록 반영 → `https://graph.example.com` (Browser, Bolt 웹소켓) 동작.

실행(현재 구성):
```sh
docker compose -p careerloop-graph -f docker-compose.yml -f docker-compose.tls.yml up -d
```

## 앱(Vercel)용 Bolt 공개 — 남은 단계

1. 외부 공개 오버레이로 다시 띄우기(0.0.0.0:7697, TLS 필수):
   ```sh
   docker compose -p careerloop-graph -f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.public.yml up -d
   ```
2. 공유기 포트 포워딩: 외부 TCP **7697 → 맥미니 7697**.
3. Vercel Production 환경 변수: `NEO4J_URI=bolt+s://graph.example.com:7697`, `NEO4J_USER=neo4j`, `NEO4J_PASSWORD=<.env 값>`.

## 인증서 갱신

```sh
C=/path/to/edge-proxy/infra/certbot; docker run --rm -v $C/conf:/etc/letsencrypt -v $C/www:/var/www/certbot certbot/certbot renew
cd /path/to/careerloop/deploy/graph && PUBLIC=1 ./sync-certs.sh   # 바뀌었으면 Neo4j 재시작(공개 구성이면 PUBLIC=1)
docker exec cbt-nginx nginx -s reload
```

## 백업

```sh
docker exec careerloop-graph neo4j-admin database dump neo4j --to-path=/data/backups   # 컨테이너 정지 필요(community)
```
