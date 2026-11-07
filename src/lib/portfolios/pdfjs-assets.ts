/**
 * 화면 PDF 보기의 pdf.js 자산 주소(서버 라우트 /pdfjs/<판>/<폴더>/<파일>과 화면 공용, 순수 함수).
 * 판은 설치된 pdfjs-dist의 package.json에서 읽는다 — 화면이 불러오는 API(legacy 빌드)와 라우트가 내려주는 워커가 늘 같은 판이다.
 */
import pdfjsPackage from "pdfjs-dist/package.json";

export const PDFJS_VERSION: string = pdfjsPackage.version;

/** 주소 폴더 → node_modules/pdfjs-dist 안의 폴더와 받는 파일 이름. */
const DIRS = {
  // 워커만(legacy 빌드: 오래된 iOS·Android 브라우저도 돌린다).
  build: { root: "legacy/build", file: /^pdf\.worker\.min\.mjs$/ },
  cmaps: { root: "cmaps", file: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.bcmap$/ },
  standard_fonts: { root: "standard_fonts", file: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(pfb|ttf)$/ },
  wasm: { root: "wasm", file: /^(openjpeg|jbig2|qcms_bg)\.wasm$|^(openjpeg|jbig2)_nowasm_fallback\.js$/ },
  iccs: { root: "iccs", file: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.icc$/ },
} as const;

export type PdfjsAssetDir = keyof typeof DIRS;
export const PDFJS_ASSET_DIRS = Object.keys(DIRS) as PdfjsAssetDir[];

/** 화면에서 쓰는 주소(끝에 '/'를 붙인 폴더 주소 — pdf.js의 cMapUrl 등은 폴더 주소를 받는다). */
export function pdfjsAssetBase(dir: PdfjsAssetDir): string {
  return `/pdfjs/${PDFJS_VERSION}/${dir}/`;
}

export const PDFJS_WORKER_URL = `${pdfjsAssetBase("build")}pdf.worker.min.mjs`;

/** 주소 조각 → pdfjs-dist 안의 상대 경로. 판이 다르거나 목록 밖이면 null(404). */
export function pdfjsAssetFile(version: string, dir: string, file: string): string | null {
  if (version !== PDFJS_VERSION) return null;
  if (!Object.hasOwn(DIRS, dir)) return null;
  const spec = DIRS[dir as PdfjsAssetDir];
  if (file.length > 80 || file.includes("..") || !spec.file.test(file)) return null;
  return `${spec.root}/${file}`;
}

export function pdfjsAssetContentType(file: string): string {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
