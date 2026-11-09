"""HMAC 서명 — TS src/lib/worker/sign.ts가 만든 공유 벡터(fixtures/hmac_vectors.json)와 같은지."""

from __future__ import annotations

from app.security.signing import canonical_string, sign_request, signed_headers, verify_signature
from tests.conftest import load_fixture

V = load_fixture("hmac_vectors.json")


def test_vectors_match_typescript() -> None:
    for v in V["vectors"]:
        assert canonical_string(v["ts"], v["method"], v["path"], v["body"]) == v["canonical"]
        assert sign_request(V["secret"], v["ts"], v["method"], v["path"], v["body"]) == v["signature"]


def test_verify_cases_match_typescript() -> None:
    for c in V["verify"]:
        got = verify_signature(V["secret"], c["timestamp"], c["signature"], c["method"], c["path"], c["body"], now_sec=c["nowSec"])
        assert got == c["expected"], c
    assert any(c["expected"] is None for c in V["verify"])
    assert any(c["expected"] == "mismatch" for c in V["verify"])


def test_bytes_and_str_bodies_sign_the_same() -> None:
    body = '{"id":"이력서","runId":"r"}'
    assert sign_request("k" * 32, "1", "POST", "/p", body) == sign_request("k" * 32, "1", "POST", "/p", body.encode("utf-8"))


def test_other_secret_fails() -> None:
    h = signed_headers("x" * 32, "POST", "/v1/jobs/a", "{}", now_sec=100)
    assert verify_signature("y" * 32, h["X-Worker-Timestamp"], h["X-Worker-Signature"], "POST", "/v1/jobs/a", "{}", now_sec=100) == "mismatch"
    assert verify_signature("x" * 32, h["X-Worker-Timestamp"], h["X-Worker-Signature"], "POST", "/v1/jobs/a", "{}", now_sec=100) is None
