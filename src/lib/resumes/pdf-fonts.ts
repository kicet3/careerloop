/**
 * 이력서 PDF 공용 글꼴 등록. 보고서 PDF(src/lib/report/pdf.tsx)와 같은 패밀리 이름·파일(NanumGothic)이라
 * 어느 쪽이 먼저 등록해도 같은 글꼴이 쓰인다. Node 런타임 전용.
 */
import path from "node:path";
import { Font } from "@react-pdf/renderer";
import { splitForWrap } from "@/lib/report/pdf";

export const PDF_FONT = "NanumGothic";
/** 하이픈 없이 줄바꿈(한글 긴 낱말은 splitForWrap이 글자 단위로 끊는다). */
export const NO_HYPHEN = 10000;

let registered = false;

export function registerResumeFonts() {
  if (registered) return;
  const dir = path.join(process.cwd(), "src", "lib", "report", "fonts");
  Font.register({
    family: PDF_FONT,
    fonts: [
      { src: path.join(dir, "NanumGothic-Regular.ttf"), fontWeight: 400 },
      { src: path.join(dir, "NanumGothic-Bold.ttf"), fontWeight: 700 },
      { src: path.join(dir, "NanumGothic-ExtraBold.ttf"), fontWeight: 800 },
    ],
  });
  Font.registerHyphenationCallback(splitForWrap);
  registered = true;
}
