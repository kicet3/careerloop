"""이력서 '수상·기타'(extras) 작성 기준 — TS src/lib/resumes/extras-guide.ts의 워커판(순수).

- 프롬프트 문구(EXTRAS_GUIDE_PROMPT_LINES)와 결정적 정리(normalize_extras·is_trivial_extra·extras_missing_questions)를 같은 표에서 만든다.
- 정규식은 JS와 같은 결과가 나오게 옮겼다: re.ASCII(JS의 \\d·\\b·i 플래그는 ASCII 기준)로 컴파일하고, \\s는 JS 공백 집합(JS_WS_CLASS)으로 바꿨다.
- 문자열 길이·자르기는 UTF-16 기준(js_slice)이다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.jsutil import JS_WS_CLASS, js_slice, js_trim

S = JS_WS_CLASS


def _re(pattern: str, ignore_case: bool = False) -> re.Pattern[str]:
    """JS 정규식 옮김: 패턴의 '<S>'는 JS \\s. ASCII 모드(JS의 \\d·\\b·대소문자 무시는 ASCII만 본다)."""
    flags = re.ASCII | (re.IGNORECASE if ignore_case else 0)
    return re.compile(pattern.replace("<S>", S), flags)


EXTRAS_CATEGORY_IDS: tuple[str, ...] = (
    "award",
    "activity",
    "training",
    "language",
    "talk",
    "opensource",
    "mentoring",
    "certification",
    "military",
    "writing",
    "patent",
    "volunteer",
    "interest",
)


@dataclass(frozen=True)
class ExtrasCategory:
    id: str
    #: 묶음 제목(기본값).
    title: str
    #: 한 줄 형식.
    format: str
    #: 쓸 때 주의(한 줄).
    note: str
    #: 묶음 제목·항목에서 카테고리를 알아보는 말(결정적 분류용).
    match: re.Pattern[str]


EXTRAS_CATEGORIES: dict[str, ExtrasCategory] = {
    "award": ExtrasCategory(
        "award",
        "수상",
        "YYYY.MM 대회명 – 상 이름 (주최) · 프로젝트/역할",
        "지원 직무와 관련된 공식 수상만. 고교 수상·직무 무관 수상은 뺀다.",
        _re(r"(수상|입상|대상|최우수|우수상|장려상|금상|은상|동상|award|해커톤|공모전|경진대회)", True),
    ),
    "activity": ExtrasCategory(
        "activity",
        "대외활동",
        "YYYY.MM ~ YYYY.MM 활동명 (기수) · 역할",
        "신입에게 중요. 직무와 이어지는 1~2개만.",
        _re(r"(대외<S>*활동|동아리|기수|서포터즈|학회|커뮤니티<S>*활동)"),
    ),
    "training": ExtrasCategory(
        "training",
        "교육",
        "YYYY.MM ~ YYYY.MM 과정명 (기관) 수료",
        "부트캠프·직무 교육. 과정 중 수상은 수상에 쓴다. 경력자는 최근 1~2개만.",
        _re(r"(교육|부트캠프|수료|아카데미|bootcamp)", True),
    ),
    "language": ExtrasCategory(
        "language",
        "어학",
        "시험명 점수 (YYYY.MM) · 회화 수준",
        "점수·취득 시기는 자료에 있을 때만.",
        _re(r"(어학|TOEIC|TOEFL|OPIc|IELTS|TEPS|JLPT|HSK|토익|토플|오픽|회화)", True),
    ),
    "talk": ExtrasCategory(
        "talk",
        "발표",
        "행사명 YYYY – 「발표 제목」 (링크)",
        "연사·발표만. 단순 참석은 뺀다.",
        _re(r"(발표|강연|연사|세미나<S>*발표|컨퍼런스|콘퍼런스|밋업|meetup|talk)", True),
    ),
    "opensource": ExtrasCategory(
        "opensource",
        "오픈소스",
        "org/repo – 기여 한 줄 (PR, 기간)",
        "머지된 기여·메인테이너 역할 위주.",
        _re(r"(오픈소스|open<S>*source|컨트리뷰|contribut|github\.com/|PR<S>*#\d+|\bPR\b[^\n]{0,20}(머지|merge|병합|반영))", True),
    ),
    "mentoring": ExtrasCategory(
        "mentoring",
        "멘토링·커뮤니티",
        "YYYY 프로그램명 멘토(리뷰어·운영진)",
        "경력자에게 의미 있다.",
        _re(r"(멘토|멘토링|리뷰어|운영진|스터디<S>*리더|코치)"),
    ),
    "certification": ExtrasCategory(
        "certification",
        "자격증",
        "YYYY.MM 자격증명 (발급 기관)",
        "자격 섹션이 따로 없을 때만 여기에. 직무와 관련 없는 자격(운전면허·워드·ITQ·한국사 등, 개발직 기준)은 뺀다.",
        _re(r"(자격증|자격|산업기사|정보처리기사|AWS<S>*Certified|SQLD|SQLP|ADsP|CKA)", True),
    ),
    "military": ExtrasCategory(
        "military",
        "병역",
        "병역: 육군 병장 만기전역 (YYYY.MM ~ YYYY.MM) / 산업기능요원 / 면제",
        "신입 남성은 사실상 필수, 경력자는 선택. 군별·계급·기간·병과 정도만, 복무 중 일화는 쓰지 않는다.",
        _re(r"(병역|만기<S>*전역|(육|해|공)군|해병|병장|산업기능요원|전문연구요원|군<S>*면제|군필|미필)"),
    ),
    "writing": ExtrasCategory(
        "writing",
        "기고·블로그",
        "블로그: URL – 대표 글 1~2개",
        "머리글 링크와 겹치면 뺀다.",
        _re(r"(블로그|기고|칼럼|아티클|velog|tistory|medium\.com|brunch)", True),
    ),
    "patent": ExtrasCategory(
        "patent",
        "특허·논문",
        "YYYY.MM 「제목」 (학회·저널·출원번호) · 역할",
        "연구·ML 직무에서 더 중요.",
        _re(r"(특허|논문|학회|저널|journal|paper|출원|등록번호)", True),
    ),
    "volunteer": ExtrasCategory(
        "volunteer",
        "봉사",
        "YYYY.MM ~ YYYY.MM 봉사 활동명 (기관) · 역할",
        "신입만, 직무와 관련 있을 때만.",
        _re(r"(봉사|volunteer)", True),
    ),
    "interest": ExtrasCategory(
        "interest",
        "관심 분야",
        "관심 기술: 주제 – 한 줄",
        "권장하지 않는다. 직무와 이어지는 기술적 관심사만.",
        _re(r"(관심<S>*(분야|기술|사|주제)|취미)"),
    ),
}

#: 경력자 순서(빈 카테고리는 생략).
EXTRAS_ORDER_EXPERIENCED: tuple[str, ...] = (
    "talk",
    "writing",
    "opensource",
    "award",
    "mentoring",
    "training",
    "language",
    "certification",
    "patent",
    "military",
    "activity",
    "volunteer",
    "interest",
)

#: 신입 순서.
EXTRAS_ORDER_NEWCOMER: tuple[str, ...] = (
    "training",
    "award",
    "activity",
    "opensource",
    "language",
    "certification",
    "talk",
    "writing",
    "patent",
    "volunteer",
    "military",
    "mentoring",
    "interest",
)

#: 넣지 않는 것(프롬프트용).
EXTRAS_EXCLUDE: tuple[str, ...] = (
    "직무와 관련 없는 수상·자격증·아르바이트",
    "너무 오래된 경험(고교 시절 등)",
    "경력·프로젝트에 이미 쓴 내용의 반복",
    "사소한 작업 일화·소감(예: '툴을 1일 만에 만듦', '많이 배웠다')",
    "맥락 없는 링크",
    "개인 신상(가족·나이·종교·결혼)",
    "직무와 무관한 취미·게임",
    "단순 참석(발표·수상·운영 없이 행사에 간 것)",
    "기타가 경력보다 길어지는 분량",
    "허위·과장(자료에 없는 점수·순위·기간)",
)

#: 항목이 2개 이하면 한 묶음으로 합칠 때 쓰는 제목.
EXTRAS_MERGED_TITLE = "수상·기타"
#: 묶음 수 상한(스키마 8).
MAX_GROUPS = 8
#: 묶음 안 항목 상한(스키마 15).
MAX_ITEMS = 15


def _order_text(order: tuple[str, ...]) -> str:
    return " > ".join(EXTRAS_CATEGORIES[i].title for i in order if i not in ("interest", "volunteer"))


#: 단일 초안·에이전트 사실 규칙 9번(RESUME_FACT_RULES)으로 들어가는 문구.
EXTRAS_GUIDE_PROMPT_LINES: tuple[str, ...] = (
    "9. extras(수상·기타)와 certifications는 채용 담당자가 의미 있게 볼 항목만, 자료에 있는 사실로만 넣는다(한국 개발자 이력서 관행 기준):",
    "   - 카테고리와 한 줄 형식(extras[].title은 묶음 제목, items는 한 줄씩):",
    *(
        f'     · {EXTRAS_CATEGORIES[i].title}: "{EXTRAS_CATEGORIES[i].format}" — {EXTRAS_CATEGORIES[i].note}'
        for i in EXTRAS_CATEGORY_IDS
        if i != "interest"
    ),
    f"   - 넣지 않는 것: {', '.join(EXTRAS_EXCLUDE)}.",
    f"   - 묶음 순서: 경력자 = {_order_text(EXTRAS_ORDER_EXPERIENCED)} / 신입 = {_order_text(EXTRAS_ORDER_NEWCOMER)}. 빈 묶음은 만들지 않는다.",
    f"   - 전체 항목이 2개 이하면 묶음을 나누지 않고 '{EXTRAS_MERGED_TITLE}' 한 묶음으로 쓴다. 묶음 안은 최신순.",
    "   - 날짜·점수·순위·기관명은 자료에 있을 때만 쓴다. 형식에 필요한 값이 없으면 그 칸만 `[ADD: …]`로 둔다.",
    "   - 흔히 쓰는 정보(수상·어학 점수, 신입이면 교육 이수·병역)가 자료에 없으면 지어내지 말고 missingInfo에 '○○이 있으면 알려 주세요' 질문으로 남긴다.",
    "   - 넣을 만한 항목이 없으면 빈 배열로 둔다. 칸을 채우려고 억지로 넣지 않는다.",
)

# ---------------------------------------------------------------------------
# 결정적 판정·정리
# ---------------------------------------------------------------------------

#: 사소한 작업 일화·소감. 수상·발표·오픈소스·특허처럼 실적이 분명한 줄에는 적용하지 않는다.
_ANECDOTE_RE = (
    _re(r"\d+<S>*(일|시간|분)<S>*만에"),
    _re(r"(만들어<S>*(봄|봤|보았)|해<S>*(봄|봤|보았))"),
    _re(r"(소감|느꼈|느낀<S>*점|배웠|배운<S>*점|보람|뿌듯|재미있|즐거웠|성장할<S>*수<S>*있었)"),
)
#: 개인 신상·무관한 취미(어떤 줄이든 뺀다).
_PERSONAL_RE = _re(r"(가족|종교|결혼|기혼|미혼|게임<S>*(랭크|티어|레벨))")
#: 실적이 분명한 줄.
_ACHIEVEMENT_RE = _re(r"(수상|입상|대상|최우수|우수상|장려상|금상|은상|동상|award|\d+<S>*위\b|발표|강연|연사|특허|논문|출원|등록번호)", True)
_ATTEND_ONLY_RE = _re(r"(참석|청강|참관)")
_ATTEND_OK_RE = _re(r"(발표|연사|수상|입상|운영|멘토|스태프|주최)")
_ADD_RE = re.compile(r"\[ADD:[^\]]*\]")
_DATE_RE = _re(r"((?:19|20)\d{2})(?:[.\-/]<S>?(\d{1,2}))?")
_ONGOING_RE = _re(r"현재|재학|진행<S>*중")


def is_trivial_extra(text: str) -> bool:
    """사소한 일화·소감·신상·단순 참석(결정적으로 빼는 기타 줄)."""
    t = js_trim(_ADD_RE.sub(" ", text))
    if not t:
        return False
    if _PERSONAL_RE.search(t):
        return True
    achievement = bool(_ATTEND_OK_RE.search(t) or _ACHIEVEMENT_RE.search(t) or EXTRAS_CATEGORIES["opensource"].match.search(t))
    if achievement:
        return False
    if any(r.search(t) for r in _ANECDOTE_RE):
        return True
    return bool(_ATTEND_ONLY_RE.search(t))


def classify_extra(title: str, items: list[str] | tuple[str, ...] = ()) -> str | None:
    """묶음 제목(없으면 항목)으로 카테고리를 고른다. 모르면 None."""
    for text in [title, *items]:
        if not js_trim(text):
            continue
        for cid in EXTRAS_CATEGORY_IDS:
            if EXTRAS_CATEGORIES[cid].match.search(text):
                return cid
    return None


def extra_date_key(text: str) -> int | None:
    """줄 앞부분의 날짜(YYYY.MM 또는 YYYY) → 정렬 키(큰 값이 최신). 날짜가 없으면 None. 기간이면 끝(없으면 시작) 기준."""
    dates = [int(m.group(1)) * 100 + (min(12, int(m.group(2))) if m.group(2) else 0) for m in _DATE_RE.finditer(text)]
    if not dates:
        return None
    if _ONGOING_RE.search(text):
        return 999_999
    return max(dates[:2])


def sort_newest_first(items: list[str]) -> list[str]:
    """최신순(날짜 없는 줄은 원래 순서로 뒤에). 안정 정렬."""
    keyed = [(text, i, extra_date_key(text)) for i, text in enumerate(items)]
    # TS 비교 함수와 같은 순서: 날짜 있는 줄(큰 키 먼저, 같으면 원래 순서) → 날짜 없는 줄(원래 순서).
    keyed.sort(key=lambda x: (0, -x[2], x[1]) if x[2] is not None else (1, 0, x[1]))
    return [x[0] for x in keyed]


@dataclass
class NormalizeExtrasResult:
    extras: list[dict[str, Any]]
    #: 뺀 줄(사소한 일화·소감 등).
    dropped: list[str]


def normalize_extras(extras: list[dict[str, Any]], *, newcomer: bool, drop_trivial: bool = True) -> NormalizeExtrasResult:
    """묶음 규칙을 결정적으로 적용한다(입력을 바꾸지 않는다). TS normalizeExtras와 같다."""
    dropped: list[str] = []
    groups: list[dict[str, Any]] = []
    for g in extras:
        items: list[str] = []
        for raw in g["items"]:
            x = js_trim(raw)
            if not x:
                continue
            if drop_trivial and is_trivial_extra(x):
                dropped.append(x)
                continue
            items.append(x)
        if items:
            groups.append({"title": js_trim(g["title"]), "items": items})
    total = sum(len(g["items"]) for g in groups)
    if total == 0:
        return NormalizeExtrasResult([], dropped)
    if total <= 2:
        merged = [x for g in groups for x in g["items"]]
        return NormalizeExtrasResult([{"title": EXTRAS_MERGED_TITLE, "items": sort_newest_first(merged)}], dropped)
    order = EXTRAS_ORDER_NEWCOMER if newcomer else EXTRAS_ORDER_EXPERIENCED

    def rank(g: dict[str, Any]) -> int:
        c = classify_extra(g["title"], g["items"])
        return len(order) if c is None else order.index(c)

    ranked = sorted(((g, i, rank(g)) for i, g in enumerate(groups)), key=lambda x: (x[2], x[1]))
    out = [{"title": js_slice(g["title"], 0, 80) or EXTRAS_MERGED_TITLE, "items": sort_newest_first(g["items"])[:MAX_ITEMS]} for g, _, _ in ranked]
    return NormalizeExtrasResult(out[:MAX_GROUPS], dropped)


def is_newcomer_document(doc: dict[str, Any]) -> bool:
    """문서가 신입(경력 항목이 비었음)인지."""
    return not any(js_trim(e["company"]) or js_trim(e["title"]) for e in doc["experience"])


def extras_missing_questions(doc: dict[str, Any]) -> list[str]:
    """흔히 쓰는 기타 정보(수상·어학, 신입이면 교육 이수·병역)가 문서에 없을 때 물을 질문(최대 1개)."""
    texts = [t for t in [*(x for g in doc["extras"] for x in [g["title"], *g["items"]]), *(f"{c['name']} {c['issuer']}" for c in doc["certifications"])] if js_trim(t)]

    def has(cid: str) -> bool:
        return any(EXTRAS_CATEGORIES[cid].match.search(t) for t in texts)

    wanted = ["award", "language", "training", "military"] if is_newcomer_document(doc) else ["award", "language"]
    missing = [EXTRAS_CATEGORIES[c].title for c in wanted if not has(c)]
    if not missing:
        return []
    return [f"{'·'.join(missing)} 정보가 자료에 없어 '수상·기타'에 넣지 않았습니다. 해당하는 것이 있으면 날짜·기관과 함께 알려 주세요(없으면 그대로 두세요)."]
