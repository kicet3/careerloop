/** 도구 입력 id 형식(§4.1). 노드 id(n_…)·청크 id(ch_…)는 형식에서 거부한다 — 이번 요청 레지스트리의 handle·evidence_id만 받는다. */
import { z } from "zod";

export const HandleSchema = z.string().regex(/^[NC][1-9][0-9]{0,2}$/);
export const EvidenceIdSchema = z.string().regex(/^ev_[A-Za-z0-9_-]{22}$/);
export const EVIDENCE_ID_RE = /ev_[A-Za-z0-9_-]{22}/g;
