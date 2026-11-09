# CareerLoop AI 워커(FastAPI). 빌드 문맥은 worker/ 폴더다(docker-compose.yml 참고).
#   docker build -f deploy/worker/Dockerfile -t careerloop-worker worker
FROM python:3.12-slim AS build
# uv는 PyPI에서 고정 버전으로 받는다(로컬 개발과 같은 버전).
RUN pip install --no-cache-dir uv==0.11.6
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
# 의존성 층(잠금 파일이 바뀔 때만 다시 받는다)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app

FROM python:3.12-slim
# root가 아닌 고정 uid로 실행한다(docs/PYTHON-WORKER.md §7).
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin worker
COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=root:root /app/app /app/app
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=3).status == 204 else 1)"]
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090", "--no-server-header", "--timeout-graceful-shutdown", "20"]
