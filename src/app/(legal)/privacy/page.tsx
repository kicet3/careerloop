import type { Metadata } from "next";
import Link from "next/link";
import { DocTitle, Placeholder, Section, Toc } from "@/components/legal/LegalDoc";
import { ProcessingTable, TransferTable, emphasisClass } from "@/components/legal/PrivacySummary";
import { BUSINESS, SERVICE_NAME } from "@/lib/brand";
import { PRIVACY_VERSION } from "@/lib/legal/consents";
import { CONSENT_PROCESSING, CONTRACT_PROCESSING, OVERSEAS_TRANSFERS } from "@/lib/legal/privacy-data";

export const metadata: Metadata = { title: "개인정보 처리방침" };

/**
 * 개인정보 처리방침(개인정보 보호법 제30조, 시행령 제31조, 개인정보위 작성지침 2025.4·2026.4 목차 기준).
 * 고치면 src/lib/legal/consents.ts의 PRIVACY_VERSION을 올리고 '변경 이력'에 한 줄 추가한다. 표 데이터는 src/lib/legal/privacy-data.ts.
 */
const TOC = [
  { id: "p1", title: "1. 처리 목적" },
  { id: "p2", title: "2. 처리 항목과 근거" },
  { id: "p3", title: "3. 처리·보유 기간" },
  { id: "p4", title: "4. 파기 절차와 방법" },
  { id: "p5", title: "5. 제3자 제공" },
  { id: "p6", title: "6. 처리위탁" },
  { id: "p7", title: "7. 국외 이전" },
  { id: "p8", title: "8. 생성형 AI 이용 안내" },
  { id: "p9", title: "9. 민감정보·고유식별정보" },
  { id: "p10", title: "10. 만 14세 미만 아동" },
  { id: "p11", title: "11. 정보주체의 권리와 행사 방법" },
  { id: "p12", title: "12. 안전성 확보 조치" },
  { id: "p13", title: "13. 자동 수집 장치(쿠키)" },
  { id: "p14", title: "14. 광고성 정보 전송" },
  { id: "p15", title: "15. 개인정보 보호책임자" },
  { id: "p16", title: "16. 권익침해 구제 방법" },
  { id: "p17", title: "17. 처리방침의 변경" },
];

const CONTACT = `${BUSINESS.email} · ${BUSINESS.phone}`;

export default function PrivacyPage() {
  const address = BUSINESS.address.trim();
  return (
    <>
      <DocTitle title="개인정보 처리방침" effective={PRIVACY_VERSION}>
        <p>
          {BUSINESS.legalName}(이하 &lsquo;회사&rsquo;)는 {SERVICE_NAME} 서비스를 제공하면서 「개인정보 보호법」 등 관련 법령을 지키고, 이용자의 개인정보를
          아래와 같이 처리합니다.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            서비스에 꼭 필요한 정보는 <strong>동의 없이 회원 계약 이행을 근거로</strong> 처리하고, 광고성 정보 수신만 <strong>선택 동의</strong>로 받습니다.
          </li>
          <li>
            <strong className={emphasisClass}>입력한 이력서·공고·경력 정보는 AI 모델 학습에 쓰지 않습니다.</strong>
          </li>
          <li>개인정보를 제3자에게 제공하지 않습니다. 호스팅·저장·AI 처리를 해외 사업자에게 맡깁니다(6·7항).</li>
        </ul>
      </DocTitle>
      <Toc items={TOC} />

      <Section id="p1" title="1. 개인정보의 처리 목적">
        <ol>
          <li>회원 가입·식별·로그인, 가입 승인과 이용 제한 관리, 회원 탈퇴 처리</li>
          <li>이력서 진단, 이력서 작성·버전 관리, 채용공고 분석과 적합도 비교, 지원 현황 관리, 경험 그래프와 경력 정리 대화 제공</li>
          <li>회원이 URL로 가져오거나 직접 입력한 채용공고를 &lsquo;공고 찾기&rsquo; 목록으로 제공</li>
          <li>문의·불만 처리, 공지 전달, 보안·부정 이용 방지</li>
          <li>(선택 동의한 경우) 새 기능·이벤트 등 광고성 정보 이메일 발송</li>
        </ol>
      </Section>

      <Section id="p2" title="2. 처리하는 개인정보 항목과 근거">
        <p>
          회사는 아래 표의 정보만 처리합니다. 수집 방법은 Google 계정 로그인 연동(이메일·이름·계정 식별자), 회원의 직접 입력·파일 업로드, (회원이
          GitHub 계정을 연결하고 저장소를 고른 경우) GitHub에서 그 저장소 정보 읽기, 서비스 이용 중 자동 생성(접속 기록·쿠키)입니다.
        </p>
        <ProcessingTable rows={CONTRACT_PROCESSING} caption="① 동의 없이 처리하는 항목 — 회원 계약 이행(개인정보 보호법 제15조①4호)" />
        <ProcessingTable rows={CONSENT_PROCESSING} caption="② 동의를 받아 처리하는 항목 — 선택(거부해도 서비스 이용에 제한 없음)" />
        <p className="text-xs text-slate-500">
          ①의 항목은 서비스를 제공하는 데 꼭 필요하여 동의 대상이 아니며, 처리를 원하지 않으면 가입하지 않거나 탈퇴할 수 있습니다. 이 경우 서비스를
          이용할 수 없습니다.
        </p>
      </Section>

      <Section id="p3" title="3. 개인정보의 처리·보유 기간">
        <ul>
          <li>
            회원 정보와 이용자가 입력한 자료: <strong className={emphasisClass}>회원 탈퇴 시까지</strong>(이용자가 개별 자료를 지우면 그때까지)
          </li>
          <li>
            광고성 정보 수신 동의 정보: <strong className={emphasisClass}>동의 철회 또는 회원 탈퇴 시까지</strong>
          </li>
          <li>로그인 세션: 최대 30일(로그아웃·탈퇴·이용 정지 시 즉시 삭제)</li>
          <li>공용 공고 내용(공개 채용공고): 회원 탈퇴 후에도 남을 수 있으나, 가져온 회원과의 연결은 탈퇴 시 삭제</li>
          <li>GitHub 연결 정보(암호화한 토큰)와 가져온 저장소 정보: GitHub 연결 해제 또는 회원 탈퇴 시까지(경험 그래프에 적용한 내용은 그래프 자료로 남음)</li>
        </ul>
        <p>
          현재 다른 법령에 따라 별도로 보존하는 개인정보는 없습니다. 유료 서비스 도입 등으로 보존 의무가 생기면 그 근거·항목·기간을 이 방침에
          추가합니다.
        </p>
      </Section>

      <Section id="p4" title="4. 개인정보의 파기 절차와 방법">
        <ol>
          <li>보유 기간이 끝나거나 처리 목적을 달성한 개인정보는 지체 없이(5일 이내) 파기합니다.</li>
          <li>
            회원 탈퇴 시 경험 그래프 → 저장소 파일(이력서·공고 파일, PDF) → 데이터베이스의 회원 정보와 관련 기록 순으로 삭제하며, 전자 파일은 복구할 수
            없는 방법으로 지웁니다. 클라우드 사업자의 백업에 남은 사본은 각 사의 백업 주기에 따라 순차 삭제됩니다.
          </li>
          <li>종이 문서로 된 개인정보는 처리하지 않습니다.</li>
          <li>회사는 휴면 계정 제도를 운영하지 않습니다. 장기간 이용하지 않아도 탈퇴 전까지 정보는 3항의 기간 동안 보관됩니다.</li>
        </ol>
      </Section>

      <Section id="p5" title="5. 개인정보의 제3자 제공">
        <p>
          회사는 개인정보를 제3자에게 제공하지 않습니다. 법령에 특별한 규정이 있는 경우(수사기관의 적법한 요청 등)는 예외입니다. 앞으로 제공이 필요하면
          받는 자·목적·항목·보유기간과 거부할 권리를 알리고 별도로 동의를 받습니다.
        </p>
        <p>
          이용자가 직접 MCP 토큰을 만들어 외부 AI 앱(예: Claude Code·Cursor·Claude Desktop)에 넣으면, 그 앱이 요청할 때 회사는 이용자 본인의 경험
          그래프(경력·프로젝트·역량 정보와 이름)를 그 앱으로 보냅니다. 이용자의 요청에 따라 이용자 자신에게 정보를 전달하는 것으로 제3자 제공이
          아니며, 전달된 뒤의 처리는 이용자가 고른 앱의 정책을 따릅니다. 이메일 등 계정 정보와 진단·이력서·공고는 보내지 않습니다. 이용자는
          계정 메뉴의 ‘MCP 연결’ 화면에서 토큰을 폐기해 언제든 전달을 멈출 수 있습니다.
        </p>
        <p>
          이용자가 GitHub 계정을 연결하면 회사는 이용자가 고른 저장소의 정보(2항 표)를 GitHub에서 읽기만 하며, GitHub에 이용자 정보를 제공하지
          않습니다(로그인·권한 확인에 필요한 요청만 보냅니다). 기본은 공개 저장소만 읽고, 비공개 저장소는 이용자가 GitHub에서 허용하고 계정 설정에서
          &lsquo;비공개 저장소도 가져오기&rsquo;를 켠 경우에만 읽습니다. 계정 설정의 &lsquo;연결된 서비스&rsquo;에서 연결을 해제하면 GitHub 접근 권한을
          해지하고 가져온 저장소 정보를 지우며, GitHub 설정(Settings → Applications)에서 앱을 직접 제거할 수도 있습니다.
        </p>
      </Section>

      <Section id="p6" title="6. 개인정보 처리위탁">
        <p>회사는 서비스 제공을 위해 아래와 같이 개인정보 처리 업무를 맡깁니다. 수탁자는 모두 해외 사업자이며, 국외 이전 내용은 7항에 있습니다.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-xs">
            <thead>
              <tr>
                <th className="border border-slate-200 bg-slate-50 px-2 py-1.5 text-left">수탁자</th>
                <th className="border border-slate-200 bg-slate-50 px-2 py-1.5 text-left">위탁 업무</th>
              </tr>
            </thead>
            <tbody>
              {OVERSEAS_TRANSFERS.map((r) => (
                <tr key={r.recipient}>
                  <td className="border border-slate-200 px-2 py-1.5">{r.recipient}</td>
                  <td className="border border-slate-200 px-2 py-1.5">{r.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          회사는 위탁 계약(각 사의 데이터 처리 부속계약 등)으로 목적 외 처리 금지, 안전성 확보 조치, 재위탁 제한, 관리·감독, 손해배상 책임을 정하고
          수탁자가 개인정보를 안전하게 처리하는지 확인합니다. 수탁자나 위탁 업무가 바뀌면 이 방침으로 알립니다.
        </p>
        <p>경험 그래프 저장 서버(Neo4j)는 회사가 국내에서 직접 운영하며 위탁하지 않습니다.</p>
      </Section>

      <Section id="p7" title="7. 개인정보의 국외 이전">
        <p>
          회사는 서비스 제공 계약의 이행에 필요한 처리위탁·보관을 위해 아래와 같이 개인정보를 국외로 이전합니다(개인정보 보호법 제28조의8 제1항
          제3호).
        </p>
        <TransferTable detailed />
      </Section>

      <Section id="p8" title="8. 생성형 AI 이용 안내">
        <ul>
          <li>
            <strong>이용 맥락</strong>: 이력서 진단, 공고 분석·적합도 비교, 이력서 초안 작성, 경력 정리 대화에서 회원이 입력한 텍스트·파일 내용을
            AI(Anthropic의 Claude)에 보내 결과를 받습니다.
          </li>
          <li>
            <strong>처리 항목</strong>: 회원이 입력한 텍스트·첨부 파일에서 읽은 내용과 AI가 만든 결과물(2항 표 참고).
          </li>
          <li>
            <strong className={emphasisClass}>학습 이용</strong>: 회원의 입력과 결과물은 회사나 AI 사업자의 AI 모델 학습에 쓰지 않습니다. 따라서
            별도의 학습 거부 절차가 필요하지 않으며, 학습에 쓰게 되면 사전에 알리고 별도 동의를 받습니다.
          </li>
          <li>
            <strong>입력 주의</strong>: 주민등록번호, 건강·병력, 종교, 정치 성향, 노동조합 가입, 가족 관계 등 민감한 정보는 입력하지 마세요. 이력서의
            연락처·주소도 진단에 꼭 필요하지 않으면 지운 뒤 올리는 것을 권장합니다.
          </li>
          <li>
            <strong>의도된 용례</strong>: AI 결과물은 지원 서류를 다듬기 위한 참고 의견입니다. 회사는 AI 결과로 회원의 권리·의무에 영향을 주는 결정을
            하지 않습니다(가입 승인은 관리자가 직접 판단합니다).
          </li>
          <li>
            <strong>부적절한 결과 신고</strong>: 부정확하거나 부적절한 결과는 {BUSINESS.email}로 알려 주세요. 확인 후 회신하고 개선에 반영합니다.
          </li>
        </ul>
      </Section>

      <Section id="p9" title="9. 민감정보·고유식별정보">
        <p>
          회사는 민감정보(개인정보 보호법 제23조)와 주민등록번호 등 고유식별정보(제24조·제24조의2)를 수집하지 않습니다. 회원이 올린 자료에 이런
          정보가 들어 있으면 지운 뒤 다시 올리거나 해당 자료를 삭제해 주세요. 삭제를 요청하면 지체 없이 처리합니다.
        </p>
      </Section>

      <Section id="p10" title="10. 만 14세 미만 아동의 개인정보">
        <p>회사는 만 14세 미만 아동의 가입을 받지 않습니다. 가입 시 만 14세 이상임을 확인하며, 만 14세 미만임이 확인되면 계정과 정보를 지체 없이 삭제합니다.</p>
      </Section>

      <Section id="p11" title="11. 정보주체의 권리와 행사 방법">
        <ol>
          <li>회원은 언제든 자신의 개인정보 열람·정정·삭제·처리정지를 요구하고, 동의를 철회할 수 있습니다(개인정보 보호법 제35조~제37조).</li>
          <li>
            방법: 서비스 화면에서 직접(자료 수정·삭제, 설정 &gt; 계정에서 광고성 정보 수신 철회와 회원 탈퇴) 하거나, {CONTACT}로 요청하면 지체 없이(10일
            이내) 처리하고 결과를 알립니다.
          </li>
          <li>법정대리인이나 위임을 받은 사람을 통해서도 행사할 수 있습니다. 이 경우 위임장을 제출해야 합니다.</li>
          <li>다른 사람의 권리를 침해하거나 법령상 제한이 있는 경우 요구가 제한될 수 있으며, 그 이유를 알립니다.</li>
          <li>회사는 AI로 회원에게 중대한 영향을 미치는 완전히 자동화된 결정을 하지 않습니다(제37조의2).</li>
        </ol>
      </Section>

      <Section id="p12" title="12. 개인정보의 안전성 확보 조치">
        <ul>
          <li>관리적 조치: 개인정보 처리 담당자 최소화, 관리자 권한 분리, 접근 권한 정기 점검</li>
          <li>
            기술적 조치: 전 구간 암호화 통신(HTTPS·TLS), 비밀번호 단방향 암호화(bcrypt), 로그인 세션 토큰의 해시 저장, IP 주소는 원문 대신 해시 저장,
            데이터베이스 행 단위 접근 통제, 회원별 자료 분리, 요청 횟수 제한
          </li>
          <li>물리적 조치: 클라우드 사업자의 보안 인증 데이터센터 이용, 자체 운영 서버의 접근 통제</li>
        </ul>
      </Section>

      <Section id="p13" title="13. 자동 수집 장치(쿠키)의 설치·운영과 거부">
        <ol>
          <li>
            회사는 로그인 유지와 보안을 위한 필수 쿠키만 씁니다: 로그인 세션 쿠키(최대 30일), Google 로그인 보안 쿠키(10분), 가입 동의 확인 쿠키(10분).
            분석·광고용 쿠키나 추적 도구는 쓰지 않습니다.
          </li>
          <li>
            브라우저 설정에서 쿠키를 거부할 수 있습니다(Chrome: 설정 &gt; 개인정보 및 보안 &gt; 서드 파티 쿠키 / Safari: 설정 &gt; 개인정보 보호 /
            Edge: 설정 &gt; 쿠키 및 사이트 권한). 다만 필수 쿠키를 거부하면 로그인이 필요한 기능을 쓸 수 없습니다.
          </li>
          <li>화면 표시 설정(사이드바 접힘 등)은 브라우저 저장소에 저장되며 개인정보를 담지 않습니다.</li>
        </ol>
      </Section>

      <Section id="p14" title="14. 광고성 정보 전송">
        <ul>
          <li>광고성 정보는 수신에 동의한 회원에게만 이메일로 보내며, 제목에 &lsquo;(광고)&rsquo;를 표시하고 수신 거부 방법을 함께 안내합니다.</li>
          <li>오후 9시부터 다음 날 오전 8시까지는 광고성 정보를 보내지 않습니다.</li>
          <li>수신 동의·철회 처리 결과는 14일 이내에 알리고, 동의 회원에게는 2년마다 수신 동의 여부를 확인합니다.</li>
          <li>설정 &gt; 계정에서 언제든 철회할 수 있으며, 철회해도 서비스 이용에 제한이 없습니다.</li>
        </ul>
      </Section>

      <Section id="p15" title="15. 개인정보 보호책임자와 고충 처리">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 rounded-lg bg-slate-50 px-4 py-3">
          <dt className="text-slate-500">보호책임자</dt>
          <dd>{BUSINESS.representative} (대표)</dd>
          <dt className="text-slate-500">이메일</dt>
          <dd>{BUSINESS.email}</dd>
          <dt className="text-slate-500">전화</dt>
          <dd>{BUSINESS.phone}</dd>
          <dt className="text-slate-500">주소</dt>
          <dd>{address || <Placeholder>[확인 필요] 사업장 주소</Placeholder>}</dd>
        </dl>
        <p>개인정보 관련 문의, 불만, 피해 구제 요청은 위 연락처로 해 주세요. 지체 없이 답변하고 처리합니다.</p>
      </Section>

      <Section id="p16" title="16. 권익침해 구제 방법">
        <p>개인정보 침해로 상담이나 구제가 필요하면 아래 기관에 문의할 수 있습니다.</p>
        <ul>
          <li>개인정보분쟁조정위원회: (국번 없이) 1833-6972, www.kopico.go.kr</li>
          <li>개인정보침해신고센터(한국인터넷진흥원): (국번 없이) 118, privacy.kisa.or.kr</li>
          <li>대검찰청: (국번 없이) 1301, www.spo.go.kr</li>
          <li>경찰청: (국번 없이) 182, ecrm.police.go.kr</li>
        </ul>
      </Section>

      <Section id="p17" title="17. 개인정보 처리방침의 변경">
        <p>
          이 방침은 {PRIVACY_VERSION}부터 시행합니다. 내용을 바꾸면 시행 7일 전(회원 권리에 중대한 변경은 30일 전)부터 서비스 화면에 공지하고, 이전
          버전을 이 페이지에서 볼 수 있게 합니다.
        </p>
        <ul>
          <li>
            {PRIVACY_VERSION}: AI 기능 이용 기록, 외부 AI 앱 연결(MCP) 토큰 정보와 이용자 요청에 따른 경험 그래프 전달, GitHub 연동(이용자가 고른 저장소
            정보로 경험 그래프 정리) 항목·보유 기간·중단 방법 추가, AI 처리 국외 이전 항목에 GitHub 저장소 정보 추가(2·3·5·7항)
          </li>
          <li>
            2026-11-06: 최초 제정 —{" "}
            <Link href="/privacy/2026-11-06" className="text-indigo-700 underline underline-offset-2">
              이전 판 보기
            </Link>
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          함께 보기:{" "}
          <Link href="/terms" className="text-indigo-700 underline underline-offset-2">
            이용약관
          </Link>
        </p>
      </Section>
    </>
  );
}
