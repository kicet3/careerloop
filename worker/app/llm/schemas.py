"""LLM 출력 스키마. 원본은 TS zod 스키마를 z.toJSONSchema로 뽑은 schemas/generated/<이름>.json이다(scripts/export-worker-schemas.ts).

- strict: TS toStrictJsonSchema와 같은 규칙으로 구조화 출력이 지원하는 부분집합으로 바꾼다(output_config.format에 넣는다).
  키 순서까지 같아야 schema_instruction 문자열·프롬프트 캐시가 같다(tests/fixtures/llm_contract.json으로 확인).
- 검증: 원본 JSON Schema(최소·최대 길이 등 포함)로 한다. zod의 transform·refine 같은 후처리는 postprocess로 따로 옮긴다
  (작업별 모듈이 같은 규칙으로 구현하고 테스트한다).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

GENERATED_DIR = Path(__file__).resolve().parent.parent / "schemas" / "generated"

_KEEP = {"type", "enum", "const", "anyOf", "$ref", "$defs", "description", "title", "properties", "required", "items", "additionalProperties"}
_STRING_FORMATS = {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}
_MAX_SAFE_INTEGER = 9007199254740991
_MIN_SAFE_INTEGER = -9007199254740991


def _js_json(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _strict(node: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    extra: list[str] = []
    for key, value in node.items():
        if key == "$defs" and isinstance(value, dict):
            out["$defs"] = {k: _strict(v) for k, v in value.items()}
        elif key == "properties" and isinstance(value, dict):
            out["properties"] = {k: _strict(v) for k, v in value.items()}
        elif key == "items" and isinstance(value, dict):
            out["items"] = _strict(value)
        elif key in ("anyOf", "oneOf") and isinstance(value, list):
            out["anyOf"] = [_strict(v) for v in value]
        elif key == "additionalProperties":
            pass  # 아래에서 객체면 false로 고정
        elif key == "minItems" and not isinstance(value, bool) and value in (0, 1):
            out["minItems"] = value
        elif key == "format" and isinstance(value, str) and value in _STRING_FORMATS:
            out["format"] = value
        elif key in _KEEP:
            out[key] = value
        elif not (key == "maximum" and value == _MAX_SAFE_INTEGER) and not (key == "minimum" and value == _MIN_SAFE_INTEGER):
            extra.append(f"{key}: {_js_json(value)}")
    if out.get("type") == "object":
        out["additionalProperties"] = False
    if extra:
        out["description"] = "\n\n".join(x for x in [out.get("description"), "{" + ", ".join(extra) + "}"] if x)
    return out


def to_strict_json_schema(raw: dict[str, Any]) -> dict[str, Any]:
    """TS toStrictJsonSchema(원본 → strict). raw에 $schema가 있으면 뺀다."""
    node = {k: v for k, v in raw.items() if k != "$schema"}
    return _strict(node)


class OutputSchema:
    """출력 스키마 하나. 같은 이름은 같은 객체(load가 캐시) — grammar-too-large 판정이 스키마 객체별로 붙는다."""

    def __init__(self, name: str, raw: dict[str, Any], postprocess: Callable[[Any], Any] | None = None) -> None:
        self.name = name
        self.raw = raw
        self.strict = to_strict_json_schema(raw)
        self.postprocess = postprocess
        self._validator = Draft202012Validator(raw)

    def problems(self, value: Any) -> list[str]:
        """검증 실패 목록(최대 10개, 'a.b: 메시지' — TS zod 이슈 형식과 같은 모양)."""
        out: list[str] = []
        for err in sorted(self._validator.iter_errors(value), key=lambda e: list(e.absolute_path)):
            path = ".".join(str(p) for p in err.absolute_path) or "(root)"
            out.append(f"{path}: {err.message}")
            if len(out) >= 10:
                break
        return out

    def parse(self, value: Any) -> tuple[bool, Any]:
        """(성공, 값 또는 문제 문자열). 성공하면 postprocess를 거친 값."""
        problems = self.problems(value)
        if problems:
            return False, "\n".join(problems)
        if self.postprocess is not None:
            try:
                return True, self.postprocess(value)
            except ValueError as e:
                return False, f"(root): {e}"
        return True, value

    def __repr__(self) -> str:
        return f"OutputSchema({self.name!r})"


@cache
def load_output_schema(name: str) -> OutputSchema:
    """schemas/generated/<name>.json(후처리 없음). 후처리가 필요하면 OutputSchema(name, raw_schema(name), postprocess)를 모듈 수준에서 한 번 만든다."""
    return OutputSchema(name, raw_schema(name))


def raw_schema(name: str) -> dict[str, Any]:
    if "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("잘못된 스키마 이름")
    return json.loads((GENERATED_DIR / f"{name}.json").read_text("utf-8"))
