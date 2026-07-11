// model-stats classify proxy — DeepSeek 키를 서버측 시크릿으로 숨기고 분류만 대행.
// 플러그인은 이 Worker URL + 공유토큰만 임베드(유료키 노출 0).
const CATS = ["simple_bug", "mystery_bug", "feature", "refactor", "deep_reasoning", "research", "config_ops", "question"];
const DOMS = ["frontend", "backend", "database", "devops", "infra", "data", "mobile", "other"];
const DIFS = ["하", "중", "상", "최상"];
const OCS = ["success", "partial", "fail", "na"];

const SYS =
  "You are a strict classifier for developer AI-assistant turns. " +
  "Given the USER PROMPT and the ASSISTANT RESPONSE, return ONLY a JSON object, no prose:\n" +
  `{"category": one of [${CATS.join(",")}], "difficulty": one of [하,중,상,최상] (intrinsic task difficulty), ` +
  `"domain": one of [${DOMS.join(",")}], "outcome": one of [success,partial,fail,na]}\n` +
  "outcome: success=fully resolved, partial=partially/uncertain, fail=couldn't do it or errored, " +
  "na=informational/question with no task to succeed at. " +
  "Judge outcome from the assistant response (apologies, errors, 'can't', unresolved = fail/partial).";

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if ((req.headers.get("authorization") || "") !== `Bearer ${env.PLUGIN_TOKEN}`)
      return json({ error: "unauthorized" }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const prompt = String(body.prompt || "").slice(0, 1500);
    const response = String(body.response || "").slice(0, 1500);
    if (!prompt.trim()) return json({ error: "empty prompt" }, 400);

    let up;
    try {
      up = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: SYS },
            { role: "user", content: `USER PROMPT:\n${prompt}\n\nASSISTANT RESPONSE:\n${response}` },
          ],
          max_tokens: 200,
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });
    } catch (e) {
      return json({ error: "upstream fetch fail" }, 502);
    }
    if (!up.ok) return json({ error: "upstream", status: up.status }, 502);

    let j;
    try {
      const d = await up.json();
      j = JSON.parse(d.choices[0].message.content);
    } catch { return json({ error: "parse fail" }, 502); }

    return json({
      category: CATS.includes(j.category) ? j.category : null,
      difficulty: DIFS.includes(j.difficulty) ? j.difficulty : null,
      domain: DOMS.includes(j.domain) ? j.domain : null,
      outcome: OCS.includes(j.outcome) ? j.outcome : null,
    });
  },
};
