# dvzc

DevezCode 세션 간 오케스트레이션 커맨드 묶음. 지금 대화의 맥락을 정리해 **다른 세션에 지시를 전달**하거나,
**자식 세션을 만들어 위임**하거나, **다른 세션이 한 작업을 읽어와 숙지**한다.

> ⚠️ **DevezCode 전용.** 각 커맨드는 플러그인에 포함된 세션 릴레이 스크립트
> (`${CLAUDE_PLUGIN_ROOT}/scripts/*.js`)를 호출한다. 설치 위치와 PC 환경에 관계없이 경로가 해석되지만,
> DevezCode의 세션 데이터와 런타임 환경이 필요하므로 DevezCode 밖에서는 동작하지 않는다.
> **DevezCode 프로젝트에서만** 활성화한다(프로젝트 `.claude/settings.json` 의 `enabledPlugins`).

## 커맨드

| 커맨드 | 하는 일 | 인자 |
|---|---|---|
| `/dvzc:send` | 대화 맥락을 정리해 **기존 세션**에 자립적 지시문 전달 | `<세션이름> <시킬 일>` |
| `/dvzc:child` | 대화 맥락을 브리핑으로 정리해 **새 자식 세션**을 만들어 위임 | `<위임할 작업 설명>` |
| `/dvzc:pick` | **다른 세션**의 대화/작업 내용을 읽어와 현재 세션이 숙지 | `<세션이름>에서 …읽어/merge해/요약해` |

세 커맨드 모두 실제 코드 작업은 하지 않고, 대화 맥락을 정리해 릴레이 스크립트로 넘긴다.
자식 세션 생성·브리핑 주입·프롬프트 전달은 DevezCode 앱이 처리한다.

## 설치 / 활성화 (DevezCode 전용 스코프)

```
/plugin install dvzc@devez-marketplace
```

설치 후, **DevezCode 프로젝트에서만** 켜지도록 프로젝트 설정에 활성화한다
(글로벌 `~/.claude/settings.json` 이 아니라 `C:/source/devezCode/.claude/settings.json`):

```json
{
  "enabledPlugins": {
    "dvzc@devez-marketplace": true
  }
}
```

## 파일

| 경로 | 역할 |
|---|---|
| `commands/send.md` | `/dvzc:send` — 기존 세션에 지시 전달 |
| `commands/child.md` | `/dvzc:child` — 자식 세션 생성·위임 |
| `commands/pick.md` | `/dvzc:pick` — 다른 세션 내용 읽어와 숙지 |

릴레이 스크립트(`send.js`, `send-new.js`, `devez-pick.js`)는 이 플러그인의 `scripts/`에 포함된다.
커맨드는 `${CLAUDE_PLUGIN_ROOT}`를 사용하므로 다른 PC나 다른 설치 경로에서도 동일하게 호출된다.

## 요구
- DevezCode 앱 실행 환경(`DEVEZCODE_ROOM_ID`와 세션 데이터가 제공되어야 함).
- `node` 가 PATH 에 있어야 함.
