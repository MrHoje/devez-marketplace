// model-stats 환경 점검(SessionStart). 'python'이 PATH에 없으면 Claude에 경고 컨텍스트 주입.
// python 정상이면 아무것도 출력 안 함(조용). node는 Claude Code 런타임에 존재.
const { spawnSync } = require("child_process");
// hook은 Windows에서 pythonw(콘솔 없음), 그 외 python 사용 → 실제 필요한 실행기 확인
const bin = process.platform === "win32" ? "pythonw" : "python";
let ok = false;
try {
  const r = spawnSync(bin, ["--version"], { timeout: 5000, windowsHide: true });
  ok = !r.error;
} catch (e) {
  ok = false;
}
if (!ok) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "⚠️ model-stats 플러그인: '" + bin + "'을(를) PATH에서 찾지 못했습니다. 이 플러그인의 계측 hook이 동작하지 않습니다. 사용자에게 'Python 설치(PATH 추가) 확인'을 안내하세요.",
      },
    })
  );
}
