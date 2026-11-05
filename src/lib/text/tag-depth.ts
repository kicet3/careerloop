/**
 * htmlparser2 열린 태그 깊이 상한. 파서는 여는 태그마다 내부 스택에 unshift하므로(O(깊이)), 닫지 않은 태그를 수십만 개
 * 쌓은 입력은 파싱만으로 O(n²)이 된다. 실제 문서는 깊이가 수십을 넘지 않으므로 상한을 넘으면 파서를 멈추고(pause)
 * 그때까지 모은 텍스트만 쓴다. 멈춘 파서는 end()를 불러도 남은 입력을 처리하지 않는다.
 */
export const MAX_TAG_DEPTH = 512;

export function tagDepthGuard(parser: () => { pause(): void }, max = MAX_TAG_DEPTH) {
  let depth = 0;
  let stopped = false;
  return {
    /** onopentag에서 부른다. 상한을 넘으면 파서를 멈춘다. */
    open() {
      if (++depth > max && !stopped) {
        stopped = true;
        parser().pause();
      }
    },
    /** onclosetag에서 부른다. */
    close() {
      depth = Math.max(0, depth - 1);
    },
    get stopped() {
      return stopped;
    },
  };
}
