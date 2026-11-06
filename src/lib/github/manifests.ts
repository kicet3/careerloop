/**
 * 저장소 루트의 의존성 파일(package.json·requirements.txt·go.mod …)에서 의존성 이름만 뽑는다(순수, 새 의존성 없음).
 * 버전·스크립트·주소는 버린다. 파일마다 이름 MAX_DEPS_PER_FILE개까지. 형식이 깨졌으면 [](던지지 않는다).
 */

export const MAX_DEPS_PER_FILE = 40;
/** 읽는 파일 크기 상한(목록의 size 기준 — 넘으면 받지 않는다). */
export const MAX_MANIFEST_BYTES = 64 * 1024;

/** 알아보는 루트 파일 이름(소문자 비교). */
export const KNOWN_MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "cargo.toml",
  "gemfile",
  "composer.json",
  "pubspec.yaml",
  "dockerfile",
  "docker-compose.yml",
] as const;

export function isKnownManifest(name: string): boolean {
  return (KNOWN_MANIFESTS as readonly string[]).includes(name.toLowerCase());
}

const NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/:+-]{0,99}$/;

function clean(names: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = raw.trim();
    if (!NAME_RE.test(n) || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
    if (out.length >= MAX_DEPS_PER_FILE) break;
  }
  return out;
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const keysOf = (v: unknown): string[] => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);

/** TOML의 [section] 본문(다음 [ 줄 전까지). */
function tomlSection(text: string, name: string): string | null {
  const re = new RegExp(`^\\[${name.replace(/[.]/g, "\\.")}\\]\\s*$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^\[/m);
  return end < 0 ? rest : rest.slice(0, end);
}

function tomlKeys(section: string | null): string[] {
  if (!section) return [];
  return [...section.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]!);
}

/** PEP 508 요구 문자열에서 이름: "requests[socks]>=2; python_version<'3.8'" → requests */
function pepName(spec: string): string {
  return spec.trim().split(/[\s\[<>=!~;@(]/)[0] ?? "";
}

export function parseManifest(fileName: string, text: string): string[] {
  const name = fileName.toLowerCase();
  if (text.length > MAX_MANIFEST_BYTES * 2) return [];
  switch (name) {
    case "package.json": {
      const o = jsonObject(text);
      return o ? clean([...keysOf(o.dependencies), ...keysOf(o.devDependencies), ...keysOf(o.peerDependencies)]) : [];
    }
    case "composer.json": {
      const o = jsonObject(text);
      return o ? clean([...keysOf(o.require), ...keysOf(o["require-dev"])].filter((k) => k !== "php" && !k.startsWith("ext-"))) : [];
    }
    case "requirements.txt":
      return clean(
        text
          .split(/\r?\n/)
          .map((l) => l.replace(/#.*$/, "").trim())
          .filter((l) => l && !l.startsWith("-") && !/^(git\+|https?:)/.test(l))
          .map(pepName),
      );
    case "pyproject.toml": {
      const project = tomlSection(text, "project");
      const deps: string[] = [];
      if (project) for (const str of tomlStringArray(project, "dependencies")) deps.push(pepName(str));
      deps.push(...tomlKeys(tomlSection(text, "tool.poetry.dependencies")).filter((k) => k.toLowerCase() !== "python"));
      deps.push(...tomlKeys(tomlSection(text, "tool.poetry.group.dev.dependencies")));
      return clean(deps);
    }
    case "cargo.toml":
      return clean([...tomlKeys(tomlSection(text, "dependencies")), ...tomlKeys(tomlSection(text, "dev-dependencies"))]);
    case "go.mod": {
      const deps: string[] = [];
      for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) {
        for (const line of block[1]!.split(/\r?\n/)) {
          const m = /^\s*([^\s/][^\s]*)\s+v[\w.+-]+/.exec(line.replace(/\/\/.*$/, ""));
          if (m) deps.push(m[1]!);
        }
      }
      for (const m of text.matchAll(/^require\s+([^\s(]+)\s+v[\w.+-]+/gm)) deps.push(m[1]!);
      return clean(deps);
    }
    case "build.gradle":
    case "build.gradle.kts": {
      const re = /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp|annotationProcessor)\s*\(?\s*["']([^"':]+):([^"':]+)(?::[^"']*)?["']/g;
      return clean([...text.matchAll(re)].map((m) => `${m[1]}:${m[2]}`));
    }
    case "pom.xml": {
      const deps: string[] = [];
      for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(m[1]!)?.[1];
        const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(m[1]!)?.[1];
        if (a && !a.includes("${")) deps.push(g && !g.includes("${") ? `${g}:${a}` : a);
      }
      return clean(deps);
    }
    case "gemfile":
      return clean([...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]!));
    case "pubspec.yaml": {
      const deps: string[] = [];
      for (const sec of ["dependencies", "dev_dependencies"]) {
        const m = new RegExp(`^${sec}:\\s*$([\\s\\S]*?)(?=^\\S|$(?![\\s\\S]))`, "m").exec(text);
        if (!m) continue;
        for (const l of m[1]!.matchAll(/^ {2}([A-Za-z0-9_]+)\s*:/gm)) deps.push(l[1]!);
      }
      return clean(deps);
    }
    case "dockerfile":
      return clean([...text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)/gim)].map((m) => m[1]!.split("@")[0]!).filter((x) => x.toLowerCase() !== "scratch" && !x.includes("$")));
    case "docker-compose.yml":
      return clean([...text.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)].map((m) => m[1]!.split("@")[0]!).filter((x) => !x.includes("$")));
    default:
      return [];
  }
}

/**
 * TOML 배열 `key = [ "a", 'b', … ]`의 문자열들. 문자열 안의 `]`(예: "requests[socks]>=2")에서 끊기지 않게 따옴표를 따라 읽는다.
 * 키가 없거나 배열이 닫히지 않으면 지금까지 읽은 문자열만.
 */
export function tomlStringArray(section: string, key: string): string[] {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m").exec(section);
  if (!m) return [];
  const out: string[] = [];
  let i = m.index + m[0].length;
  while (i < section.length) {
    const ch = section[i]!;
    if (ch === "]") break;
    if (ch === "#") {
      const nl = section.indexOf("\n", i);
      i = nl === -1 ? section.length : nl + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let str = "";
      while (j < section.length && section[j] !== ch) {
        if (ch === '"' && section[j] === "\\" && j + 1 < section.length) {
          str += section[j + 1];
          j += 2;
          continue;
        }
        str += section[j];
        j++;
      }
      if (str) out.push(str);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}
