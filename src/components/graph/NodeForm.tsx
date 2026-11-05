"use client";

import { useId, useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { type CareerGraph, type GraphNode, type GraphOp, NODE_LABEL_META, NODE_LABELS, type NodeLabel } from "@/lib/domain/graph";
import {
  buildAddNodeOps,
  buildUpdateNodeOps,
  describeEdge,
  type FieldSpec,
  type FormValues,
  fieldsFor,
  formValuesFrom,
  linkOptionsForNewNode,
} from "./model";
import { inputClass, labelClass, textareaClass } from "./styles";

/**
 * 노드 추가·수정 폼. 추가할 때는 라벨을 고르고, 선택한 끝점과의 연결 1개를 같은 변경안에 넣을 수 있다.
 * onSubmit은 GraphOp[]를 받아 서버에 보내고, 실패하면 오류 문구를 던진다(폼에 보인다).
 */
export function NodeForm({
  graph,
  node,
  initialLabel = "Company",
  onSubmit,
  onCancel,
}: {
  graph: CareerGraph;
  /** 있으면 수정, 없으면 추가. */
  node?: GraphNode;
  initialLabel?: NodeLabel;
  onSubmit: (ops: GraphOp[]) => Promise<void>;
  onCancel: () => void;
}) {
  const uid = useId();
  const [label, setLabel] = useState<NodeLabel>(node?.label ?? initialLabel);
  const [values, setValues] = useState<FormValues>(() => formValuesFrom(node?.label ?? initialLabel, node?.props));
  const [linkIdx, setLinkIdx] = useState<string>("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = useMemo(() => fieldsFor(label), [label]);
  const linkOptions = useMemo(() => (node ? [] : linkOptionsForNewNode(graph, label)), [graph, label, node]);

  function changeLabel(next: NodeLabel) {
    setLabel(next);
    setValues(formValuesFrom(next));
    setLinkIdx("0");
    setError(null);
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    const link = linkIdx === "" ? null : (linkOptions[Number(linkIdx)] ?? null);
    const result = node ? buildUpdateNodeOps(node, values) : buildAddNodeOps(label, values, link);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(result.ops);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const newName = String(values[fields[0]?.key ?? ""] ?? "").trim() || `새 ${NODE_LABEL_META[label].name}`;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h3 className="text-base font-semibold text-slate-900">
        {node ? `${NODE_LABEL_META[node.label].name} 수정` : "항목 추가"}
      </h3>

      {!node && (
        <div>
          <label htmlFor={`${uid}-label`} className={labelClass}>
            종류
          </label>
          <select id={`${uid}-label`} className={inputClass} value={label} onChange={(e) => changeLabel(e.target.value as NodeLabel)}>
            {NODE_LABELS.map((l) => (
              <option key={l} value={l}>
                {NODE_LABEL_META[l].name} — {NODE_LABEL_META[l].description}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.key} id={`${uid}-${f.key}`} spec={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
        ))}
      </div>

      {!node && (
        <div>
          <label htmlFor={`${uid}-link`} className={labelClass}>
            연결
          </label>
          <select id={`${uid}-link`} className={inputClass} value={linkIdx} onChange={(e) => setLinkIdx(e.target.value)}>
            <option value="">연결하지 않음</option>
            {linkOptions.map((o, i) => (
              <option key={`${o.type}:${o.from}:${o.to}`} value={String(i)}>
                {describeEdge(graph, o, newName)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">다른 연결은 추가한 뒤 상세 화면의 ‘연결 추가’로 더할 수 있습니다.</p>
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          취소
        </Button>
        <Button type="submit" loading={busy}>
          {node ? "저장" : "추가"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  spec,
  value,
  onChange,
}: {
  id: string;
  spec: FieldSpec;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const label = (
    <label htmlFor={id} className={labelClass}>
      {spec.label}
      {spec.required && <span className="ml-0.5 text-red-600">*</span>}
    </label>
  );
  switch (spec.kind) {
    case "boolean":
      return (
        <label htmlFor={id} className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-slate-700">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-indigo-600" />
          {spec.label}
        </label>
      );
    case "textarea":
      return (
        <div className="sm:col-span-2">
          {label}
          <textarea id={id} rows={3} className={textareaClass} value={text} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case "select":
      return (
        <div>
          {label}
          <select id={id} className={inputClass} value={text} onChange={(e) => onChange(e.target.value)}>
            <option value="">선택 안 함</option>
            {spec.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return (
        <div className={spec.required ? "sm:col-span-2" : undefined}>
          {label}
          <input
            id={id}
            type={spec.kind === "number" ? "number" : spec.kind === "url" ? "url" : "text"}
            required={spec.required}
            placeholder={spec.placeholder}
            className={inputClass}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}
