/**
 * 가입·동의 화면과 개인정보 처리방침이 함께 쓰는 표(표시 전용, 서버·클라이언트 공용).
 * 보유·이용 기간과 홍보 연락 사실은 시행령 제17조③에 따라 굵게·밑줄로 강조한다.
 */
import { CONSENT_PROCESSING, CONTRACT_PROCESSING, OVERSEAS_TRANSFERS, TRANSFER_REFUSAL, type ProcessingRow } from "@/lib/legal/privacy-data";
import { cn } from "@/components/ui/cn";

const th = "border border-slate-200 bg-slate-50 px-2 py-1.5 text-left align-top font-semibold text-slate-700";
const td = "border border-slate-200 px-2 py-1.5 align-top text-slate-700";
/** 법이 강조를 요구하는 부분(보유기간 등). 글자를 조금 키우고 굵게·밑줄. */
export const emphasisClass = "text-[1.05em] font-bold text-slate-900 underline decoration-indigo-300 underline-offset-2";

export function ProcessingTable({ rows, caption, className }: { rows: ProcessingRow[]; caption: string; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[34rem] border-collapse text-xs leading-relaxed">
        <caption className="mb-1 text-left text-xs font-semibold text-slate-800">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              처리 목적
            </th>
            <th scope="col" className={th}>
              처리 항목
            </th>
            <th scope="col" className={th}>
              보유·이용 기간
            </th>
            <th scope="col" className={th}>
              근거
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.purpose}>
              <td className={td}>{r.purpose}</td>
              <td className={td}>{r.items}</td>
              <td className={td}>
                <span className={emphasisClass}>{r.retention}</span>
              </td>
              <td className={td}>{r.basis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TransferTable({ className, detailed = false }: { className?: string; detailed?: boolean }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className={cn("w-full border-collapse text-xs leading-relaxed", detailed ? "min-w-[56rem]" : "min-w-[40rem]")}>
        <caption className="mb-1 text-left text-xs font-semibold text-slate-800">국외 이전(해외 처리위탁) — 법 제28조의8①3호</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              이전받는 자
            </th>
            <th scope="col" className={th}>
              국가
            </th>
            {detailed && (
              <th scope="col" className={th}>
                일시·방법
              </th>
            )}
            <th scope="col" className={th}>
              항목
            </th>
            <th scope="col" className={th}>
              목적
            </th>
            <th scope="col" className={th}>
              보유·이용 기간
            </th>
          </tr>
        </thead>
        <tbody>
          {OVERSEAS_TRANSFERS.map((r) => (
            <tr key={r.recipient}>
              <td className={td}>
                {r.recipient}
                {detailed && <span className="mt-0.5 block break-all text-slate-500">{r.contact}</span>}
              </td>
              <td className={td}>{r.country}</td>
              {detailed && <td className={td}>{r.when}</td>}
              <td className={td}>{r.items}</td>
              <td className={td}>{r.purpose}</td>
              <td className={td}>
                <span className={emphasisClass}>{r.retention}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{TRANSFER_REFUSAL}</p>
    </div>
  );
}

/** 가입 화면의 '개인정보 수집·이용 및 국외 이전 안내' 펼침 내용. */
export function SignupPrivacyNotice() {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-600">
        서비스 제공에 꼭 필요한 아래 정보는 회원 계약의 이행을 위해 처리합니다(개인정보 보호법 제15조①4호). 이 항목은 별도 동의 대상이 아니며,
        확인 후 가입할 수 있습니다. 확인하지 않으면 서비스를 제공할 수 없어 가입이 진행되지 않습니다.
      </p>
      <ProcessingTable rows={CONTRACT_PROCESSING} caption="수집·이용 항목(계약 이행)" />
      <TransferTable />
      <p className="text-xs leading-relaxed text-slate-600">
        제3자 제공: 없음. 입력한 정보는 AI 모델 학습에 쓰지 않습니다. 자세한 내용은{" "}
        <a href="/privacy" target="_blank" rel="noopener" className="font-semibold text-indigo-700 underline underline-offset-2">
          개인정보 처리방침
        </a>
        에서 볼 수 있습니다.
      </p>
    </div>
  );
}

/** 광고성 정보 수신(선택) 동의 내용 — 법 제15조② 고지 4가지 + 홍보 연락 사실 강조. */
export function MarketingNotice() {
  const row = CONSENT_PROCESSING[0]!;
  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-xs leading-relaxed text-slate-600">
      <dt className="font-semibold text-slate-700">목적</dt>
      <dd>
        <span className={emphasisClass}>새 기능·이벤트 등 광고성 정보를 이메일로 보내 드립니다(홍보 목적 연락).</span>
      </dd>
      <dt className="font-semibold text-slate-700">항목</dt>
      <dd>{row.items}</dd>
      <dt className="font-semibold text-slate-700">보유·이용 기간</dt>
      <dd>
        <span className={emphasisClass}>{row.retention}</span>
      </dd>
      <dt className="font-semibold text-slate-700">거부할 권리</dt>
      <dd>동의를 거부할 수 있으며, 거부해도 서비스 이용에 제한이 없습니다. 동의 후에도 설정 &gt; 계정에서 언제든 철회할 수 있습니다.</dd>
    </dl>
  );
}
