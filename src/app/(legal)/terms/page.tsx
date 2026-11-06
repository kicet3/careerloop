import type { Metadata } from "next";
import Link from "next/link";
import { DocTitle, Placeholder, Section, Toc } from "@/components/legal/LegalDoc";
import { BUSINESS, SERVICE_NAME } from "@/lib/brand";
import { TERMS_VERSION } from "@/lib/legal/consents";

export const metadata: Metadata = { title: "이용약관" };

/** 이용약관. 고치면 src/lib/legal/consents.ts의 TERMS_VERSION을 올리고 아래 '변경 이력'에 추가한다(로그인 사용자는 재동의). */
const TOC = [
  { id: "t1", title: "제1조 목적" },
  { id: "t2", title: "제2조 정의" },
  { id: "t3", title: "제3조 약관의 게시와 변경" },
  { id: "t4", title: "제4조 회원 가입과 승인" },
  { id: "t5", title: "제5조 계정 관리" },
  { id: "t6", title: "제6조 서비스의 내용" },
  { id: "t7", title: "제7조 서비스의 변경·중단" },
  { id: "t8", title: "제8조 이용자의 의무" },
  { id: "t9", title: "제9조 이용자 콘텐츠" },
  { id: "t10", title: "제10조 공용 공고(공고 찾기)" },
  { id: "t11", title: "제11조 AI 결과물" },
  { id: "t12", title: "제12조 이용 제한" },
  { id: "t13", title: "제13조 회원 탈퇴" },
  { id: "t14", title: "제14조 책임의 제한" },
  { id: "t15", title: "제15조 통지" },
  { id: "t16", title: "제16조 준거법과 관할" },
  { id: "t17", title: "부칙·변경 이력" },
];

export default function TermsPage() {
  const address = BUSINESS.address.trim();
  return (
    <>
      <DocTitle title={`${SERVICE_NAME} 이용약관`} effective={TERMS_VERSION}>
        <p>
          이 약관은 {BUSINESS.legalName}(이하 &lsquo;회사&rsquo;)가 제공하는 {SERVICE_NAME} 서비스의 이용 조건을 정합니다. 개인정보 처리에 관한
          사항은{" "}
          <Link href="/privacy" className="font-semibold text-indigo-700 underline underline-offset-2">
            개인정보 처리방침
          </Link>
          을 따릅니다.
        </p>
      </DocTitle>
      <Toc items={TOC} />

      <Section id="t1" title="제1조 목적">
        <p>
          이 약관은 회사가 제공하는 이력서 진단·작성, 채용공고 분석, 경력 정리 서비스(이하 &lsquo;서비스&rsquo;)의 이용과 관련하여 회사와 회원의
          권리·의무 및 책임 사항을 정하는 것을 목적으로 합니다.
        </p>
      </Section>

      <Section id="t2" title="제2조 정의">
        <ol>
          <li>&lsquo;회원&rsquo;이란 이 약관에 동의하고 Google 계정으로 가입하여 회사의 승인을 받은 사람을 말합니다.</li>
          <li>&lsquo;이용자 콘텐츠&rsquo;란 회원이 서비스에 올리거나 입력한 이력서, 자기소개서, 채용공고, 경력 정보, 메모, 대화 내용 등을 말합니다.</li>
          <li>&lsquo;AI 결과물&rsquo;이란 서비스가 언어 모델(AI)을 이용하여 만든 진단, 분석, 추천, 다시 쓴 문서 등을 말합니다.</li>
          <li>&lsquo;공용 공고&rsquo;란 회원이 URL로 가져오거나 직접 입력해 보관한 채용공고 중 다른 회원도 &lsquo;공고 찾기&rsquo;에서 볼 수 있는 공고를 말합니다.</li>
        </ol>
      </Section>

      <Section id="t3" title="제3조 약관의 게시와 변경">
        <ol>
          <li>회사는 이 약관을 서비스 첫 화면과 가입 화면에서 볼 수 있게 게시합니다.</li>
          <li>
            회사는 관련 법령을 어기지 않는 범위에서 약관을 바꿀 수 있습니다. 바꿀 때는 시행일과 변경 이유를 시행 7일 전(회원에게 불리한 변경은 30일
            전)부터 서비스 화면에 공지합니다.
          </li>
          <li>바뀐 약관의 시행일 이후 서비스를 이용하려면 바뀐 약관에 다시 동의해야 합니다. 동의하지 않으면 회원 탈퇴를 할 수 있습니다.</li>
        </ol>
      </Section>

      <Section id="t4" title="제4조 회원 가입과 승인">
        <ol>
          <li>가입은 Google 계정으로 합니다. 가입하려는 사람은 이 약관에 동의하고 개인정보 처리 안내를 확인해야 합니다.</li>
          <li>만 14세 미만은 가입할 수 없습니다.</li>
          <li>
            서비스는 회사의 승인을 받은 회원만 이용할 수 있습니다. 가입 직후에는 &lsquo;승인 대기&rsquo; 상태이며, 회사는 서비스 운영 여건에 따라
            승인 여부를 정합니다.
          </li>
          <li>
            회사는 다음의 경우 승인하지 않거나 나중에 승인을 취소할 수 있습니다: 타인의 정보를 도용한 경우, 만 14세 미만인 경우, 이전에 이용이 제한된
            적이 있는 경우, 그 밖에 서비스 운영을 현저히 방해할 우려가 있는 경우.
          </li>
        </ol>
      </Section>

      <Section id="t5" title="제5조 계정 관리">
        <ol>
          <li>회원은 자신의 Google 계정과 (설정한 경우) 비밀번호를 스스로 관리해야 하며, 다른 사람이 쓰게 해서는 안 됩니다.</li>
          <li>계정이 도용되었거나 그럴 우려가 있으면 바로 회사에 알려야 합니다.</li>
        </ol>
      </Section>

      <Section id="t6" title="제6조 서비스의 내용">
        <ol>
          <li>이력서 진단(AI 심사위원 의견, 채용공고 적합도 분석, 개선 방향, 다시 쓴 이력서)</li>
          <li>이력서 작성·버전 관리, 채용공고 보관함, 지원 현황 관리</li>
          <li>경력 그래프와 경력 정리 대화</li>
          <li>공고 찾기(회원이 URL로 가져오거나 직접 입력한 채용공고 목록)</li>
          <li>그 밖에 회사가 정하는 기능</li>
        </ol>
        <p>서비스는 현재 무료로 제공합니다. 유료 기능을 도입하면 요금과 조건을 미리 알리고 별도로 동의를 받습니다.</p>
      </Section>

      <Section id="t7" title="제7조 서비스의 변경·중단">
        <ol>
          <li>회사는 운영·기술상 필요에 따라 서비스의 전부 또는 일부를 바꾸거나 중단할 수 있습니다. 이 경우 미리 공지하며, 부득이한 경우 사후에 알립니다.</li>
          <li>설비 점검·장애, 외부 서비스(AI·호스팅 등)의 장애 등으로 서비스가 일시 중단될 수 있습니다.</li>
          <li>서비스를 종료할 때는 30일 전에 알리고, 회원이 자신의 자료를 내려받을 수 있는 기간을 둡니다.</li>
        </ol>
      </Section>

      <Section id="t8" title="제8조 이용자의 의무">
        <p>회원은 다음 행위를 해서는 안 됩니다.</p>
        <ol>
          <li>타인의 정보를 도용하거나 타인의 이력서를 본인 동의 없이 올리는 행위</li>
          <li>
            주민등록번호, 건강·병력, 종교, 정치 성향, 노동조합 가입 등 민감정보나 고유식별정보를 입력하는 행위(입력하지 않도록 지워 주세요)
          </li>
          <li>로그인이 필요하거나 개인용 토큰이 들어 있는 비공개 URL을 공고 가져오기에 넣는 행위</li>
          <li>자동화 도구로 과도한 요청을 보내거나, 서비스의 보안 장치를 우회하는 행위</li>
          <li>법령이나 제3자의 권리(저작권 등)를 침해하는 행위</li>
        </ol>
      </Section>

      <Section id="t9" title="제9조 이용자 콘텐츠">
        <ol>
          <li>이용자 콘텐츠의 권리는 회원에게 있습니다.</li>
          <li>
            회원은 회사가 서비스를 제공하는 데 필요한 범위(저장, AI 분석 요청, 화면 표시, PDF 생성 등)에서 이용자 콘텐츠를 처리하도록 허락합니다.
          </li>
          <li>회사는 이용자 콘텐츠를 AI 모델 학습에 쓰지 않으며, 회사가 이용하는 AI 사업자도 이를 학습에 쓰지 않습니다.</li>
          <li>회원은 언제든 자신의 콘텐츠를 지울 수 있고, 탈퇴하면 이용자 콘텐츠는 삭제됩니다(제10조의 공용 공고 내용은 예외).</li>
        </ol>
      </Section>

      <Section id="t10" title="제10조 공용 공고(공고 찾기)">
        <ol>
          <li>
            회원이 URL로 가져온 채용공고는 공고 페이지에서 뽑은 내용(회사·직무·공고 본문 등)이 &lsquo;공고 찾기&rsquo;에 공유되어 다른 회원도 볼 수
            있습니다. 같은 URL을 다른 회원이 가져오면 저장된 내용을 다시 씁니다.
          </li>
          <li>
            회원이 직접 입력한 채용공고도 공고 내용(회사·직무·공고 본문·마감·근무 조건 등)이 &lsquo;공고 찾기&rsquo;에 공유됩니다. 입력한 공고 주소는
            공유하지 않으며, 공고를 입력한 회원이 내용을 고치면 공유된 내용도 함께 바뀝니다.
          </li>
          <li>누가 가져왔거나 입력했는지는 다른 회원에게 보이지 않습니다. 메모, 지원 상태, 지원 기록은 공유되지 않습니다.</li>
          <li>공용 공고 내용은 채용공고이므로 보관함에서 공고를 지우거나 회원이 탈퇴해도 남을 수 있습니다. 부적절한 공고는 회사가 숨길 수 있습니다.</li>
        </ol>
      </Section>

      <Section id="t11" title="제11조 AI 결과물">
        <ol>
          <li>AI 결과물은 언어 모델이 만든 참고 의견입니다. 사실과 다르거나 부정확할 수 있으며, 서류 합격·면접·채용을 보장하지 않습니다.</li>
          <li>AI 결과물을 이력서 등에 쓰기 전에 회원이 내용을 확인해야 합니다. 특히 다시 쓴 문서는 회원의 실제 경력과 맞는지 확인해 주세요.</li>
          <li>
            부적절하거나 잘못된 결과물은 {BUSINESS.email}로 알려 주세요. 회사는 확인 후 개선에 반영합니다.
          </li>
          <li>이 서비스는 커리어·법률 자문이 아닙니다.</li>
        </ol>
      </Section>

      <Section id="t12" title="제12조 이용 제한">
        <ol>
          <li>회사는 회원이 제8조를 어기면 경고, 일시 정지, 이용 정지를 할 수 있습니다.</li>
          <li>정지된 회원은 로그인은 할 수 있으나 서비스를 이용할 수 없으며, 로그인 상태는 모두 해제됩니다.</li>
          <li>이용 제한에 이의가 있으면 {BUSINESS.email}로 이의를 제기할 수 있고, 회사는 정당하다고 인정하면 바로 해제합니다.</li>
        </ol>
      </Section>

      <Section id="t13" title="제13조 회원 탈퇴">
        <ol>
          <li>회원은 언제든 설정 &gt; 계정(승인 전이면 승인 대기 화면)에서 탈퇴할 수 있습니다.</li>
          <li>탈퇴하면 계정 정보와 이용자 콘텐츠, 경력 그래프, 올린 파일이 지체 없이 삭제되며 되돌릴 수 없습니다.</li>
        </ol>
      </Section>

      <Section id="t14" title="제14조 책임의 제한">
        <ol>
          <li>회사는 천재지변, 외부 서비스의 장애 등 회사의 고의·과실 없이 생긴 손해에는 책임을 지지 않습니다.</li>
          <li>회사는 AI 결과물을 바탕으로 회원이 한 판단이나 그 결과에 대해, 회사의 고의 또는 중대한 과실이 없는 한 책임을 지지 않습니다.</li>
          <li>무료 서비스의 이용과 관련하여 회사의 책임은 관련 법령이 허용하는 범위에서 제한됩니다. 다만 회사의 고의 또는 중대한 과실로 인한 손해는 예외로 합니다.</li>
        </ol>
      </Section>

      <Section id="t15" title="제15조 통지">
        <p>회사는 회원에게 알릴 사항을 가입한 이메일이나 서비스 화면 공지로 알립니다. 전체 회원에게 알릴 사항은 7일 이상 서비스 화면에 공지하는 것으로 갈음할 수 있습니다.</p>
      </Section>

      <Section id="t16" title="제16조 준거법과 관할">
        <p>이 약관은 대한민국 법을 따릅니다. 서비스 이용과 관련한 분쟁은 민사소송법에 따른 관할 법원에 제기합니다.</p>
      </Section>

      <Section id="t17" title="부칙·변경 이력">
        <p>이 약관은 {TERMS_VERSION}부터 시행합니다.</p>
        <ul>
          <li>{TERMS_VERSION}: 최초 제정</li>
        </ul>
        <p className="text-xs text-slate-500">
          회사: {BUSINESS.legalName} · 대표 {BUSINESS.representative} · 사업자등록번호 {BUSINESS.registrationNumber} · 주소{" "}
          {address || <Placeholder>[확인 필요] 사업장 주소</Placeholder>} · {BUSINESS.email} · {BUSINESS.phone}
        </p>
      </Section>
    </>
  );
}
