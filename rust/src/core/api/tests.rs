//! Ports of the api.js tests, against a tiny local HTTP server instead of a fake fetch.
use super::*;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A recorded request.
#[derive(Debug, Clone)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub auth: String,
    pub body: String,
}
impl Req {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap()
    }
}
/// How the server answers.
pub enum Answer {
    /// status, content type, body
    Full(u16, &'static str, String),
    /// SSE text sent in 7-byte chunks; `cut` drops the connection instead of ending the body
    Sse { text: String, cut: bool },
    /// SSE chunks with a pause between them, so a test can stop it midway
    Slow(Vec<String>),
    /// Never answers (until the client gives up)
    Hang,
}
type Handler = Arc<dyn Fn(&Req) -> Answer + Send + Sync>;

pub struct Mock {
    pub url: String,
    pub reqs: Arc<Mutex<Vec<Req>>>,
}
pub async fn mock(h: impl Fn(&Req) -> Answer + Send + Sync + 'static) -> Mock {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let reqs = Arc::new(Mutex::new(vec![]));
    let (h, r2): (Handler, _) = (Arc::new(h), reqs.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let (h, reqs) = (h.clone(), r2.clone());
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let header = |name: &str| {
                    head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
                };
                let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let mut first = head.lines().next().unwrap_or("").split(' ');
                let req = Req {
                    method: first.next().unwrap_or("").into(),
                    path: first.next().unwrap_or("").into(),
                    auth: header("authorization").unwrap_or_default(),
                    body: String::from_utf8_lossy(&buf[head_end..]).to_string(),
                };
                reqs.lock().unwrap().push(req.clone());
                let chunked = |ctype: &str| format!("HTTP/1.1 200 OK\r\ncontent-type: {ctype}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n");
                let chunk = |b: &[u8]| [format!("{:x}\r\n", b.len()).as_bytes(), b, b"\r\n"].concat();
                match h(&req) {
                    Answer::Full(status, ctype, body) => {
                        let _ = s
                            .write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes())
                            .await;
                    }
                    Answer::Sse { text, cut } => {
                        let _ = s.write_all(chunked("text/event-stream; charset=utf-8").as_bytes()).await;
                        for piece in text.as_bytes().chunks(7) {
                            let _ = s.write_all(&chunk(piece)).await;
                        }
                        if !cut {
                            let _ = s.write_all(b"0\r\n\r\n").await;
                        }
                    }
                    Answer::Slow(parts) => {
                        let _ = s.write_all(chunked("text/event-stream").as_bytes()).await;
                        for p in parts {
                            if s.write_all(&chunk(p.as_bytes())).await.is_err() {
                                return;
                            }
                            tokio::time::sleep(Duration::from_millis(300)).await;
                        }
                        let _ = s.write_all(b"0\r\n\r\n").await;
                    }
                    Answer::Hang => {
                        let _ = s.read(&mut tmp).await; // until the client closes
                    }
                }
                let _ = s.shutdown().await;
            });
        }
    });
    Mock { url, reqs }
}

pub fn frames(deltas: &[Value]) -> String {
    deltas.iter().map(|d| format!("data: {}\n\n", json!({ "choices": [{ "delta": d }] }))).collect::<String>() + "data: [DONE]\n\n"
}
fn sse(text: String) -> Answer {
    Answer::Sse { text, cut: false }
}
fn tool_frames(pieces: &[Value]) -> String {
    frames(&pieces.iter().map(|p| json!({ "tool_calls": p })).collect::<Vec<_>>())
}

struct Run {
    out: Result<Reply>,
    deltas: Vec<Delta>,
}
async fn run(url: &str, endpoint_override: Option<&str>, extra: Value, search: Option<&Search>, cancel: &CancellationToken) -> Run {
    let mut deltas = vec![];
    let ep = endpoint_override.map_or(url.to_string(), |e| e.to_string());
    let out = chat_stream(&Client::new(), &ep, "k", "m", vec![json!({ "role": "user", "content": "hi" })], extra, &mut |d| deltas.push(d), cancel, search).await;
    Run { out, deltas }
}
async fn simple(url: &str) -> Run {
    run(url, None, json!({}), None, &CancellationToken::new()).await
}

#[tokio::test]
async fn list_models_sorts_ids_strips_slash_and_sends_key() {
    let m = mock(|_| Answer::Full(200, "application/json", json!({ "data": [{ "id": "b" }, { "id": "a" }] }).to_string())).await;
    let ids: Vec<_> = list_models_detailed(&Client::new(), &format!("{}/v1/", m.url), "k").await.unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(ids, ["a", "b"]);
    let r = m.reqs.lock().unwrap()[0].clone();
    assert_eq!((r.method.as_str(), r.path.as_str(), r.auth.as_str()), ("GET", "/v1/models", "Bearer k"));
}

#[tokio::test]
async fn error_response_throws() {
    let m = mock(|_| Answer::Full(401, "application/json", r#"{"error":"bad key"}"#.into())).await;
    let e = list_models_detailed(&Client::new(), &m.url, "k").await.unwrap_err().to_string();
    assert!(e.starts_with("HTTP 401: ") && e.contains("bad key"), "{e}");
}

#[tokio::test]
async fn non_json_reply_gets_friendly_error() {
    let m = mock(|_| Answer::Full(200, "text/html", "<html>nope</html>".into())).await;
    assert!(list_models_detailed(&Client::new(), &m.url, "").await.unwrap_err().to_string().contains("didn't return JSON"));
}

#[tokio::test]
async fn network_failure_is_an_error() {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    assert!(list_models_detailed(&Client::new(), &url, "").await.is_err());
}

#[tokio::test]
async fn list_models_reads_reasoning_and_tools_metadata() {
    let data = json!([
        { "id": "a", "reasoning": { "mandatory": true, "supported_efforts": ["high", "low"], "default_effort": "low" } },
        { "id": "b", "reasoning": { "mandatory": false } },
        { "id": "c", "supported_parameters": ["temperature"] },
        { "id": "d" },
        { "id": "e", "supported_parameters": ["tools", "temperature"] },
    ]);
    let m = mock(move |_| Answer::Full(200, "application/json", json!({ "data": data }).to_string())).await;
    let v = list_models_detailed(&Client::new(), &m.url, "").await.unwrap();
    assert_eq!(
        v[0],
        ModelInfo { id: "a".into(), efforts: Efforts::Levels(vec!["high".into(), "low".into()]), mandatory: true, default: Some("low".into()), meta: true, tools: true }
    );
    assert_eq!(v[1].efforts, Efforts::Unknown);
    assert_eq!((v[2].efforts.clone(), v[2].tools), (Efforts::None, false));
    assert_eq!((v[3].efforts.clone(), v[3].tools), (Efforts::Unknown, true));
    assert!(v[4].tools);
}

#[test]
fn reasoning_params_per_endpoint() {
    let rp = |e, l| reasoning_params(e, l, "", false);
    assert_eq!(rp("https://api.openai.com/v1", "high"), json!({ "reasoning_effort": "high" }));
    assert_eq!(rp("https://openrouter.ai/api/v1", "low"), json!({ "reasoning": { "effort": "low" } }));
    assert_eq!(rp("https://api.openai.com/v1", ""), json!({}));
    assert_eq!(rp("https://api.deepseek.com/v1", "max"), json!({ "reasoning_effort": "max", "thinking": { "type": "enabled" } }));
    assert_eq!(rp("https://api.z.ai/api/paas/v4", "none"), json!({ "thinking": { "type": "disabled" } }));
    assert_eq!(rp("https://api.z.ai/api/paas/v4", "high"), json!({ "reasoning_effort": "high", "thinking": { "type": "enabled" } }));
    assert_eq!(rp("https://api.moonshot.ai/v1", "low"), json!({ "reasoning_effort": "low" }));
    assert_eq!(rp("https://api.moonshot.ai/v1", "none"), json!({ "thinking": { "type": "disabled" } }));
    let gw = "https://my-gateway.example.com/v1";
    assert_eq!(reasoning_params(gw, "high", "", false), json!({ "reasoning_effort": "high" }));
    assert_eq!(reasoning_params(gw, "high", "", true), json!({ "reasoning": { "effort": "high" } }));
    assert_eq!(reasoning_params(gw, "none", "thinking", false), json!({ "thinking": { "type": "disabled" } }));
    assert_eq!(reasoning_params(gw, "low", "openai", true), json!({ "reasoning_effort": "low" }));
}

#[tokio::test]
async fn streams_reasoning_and_content_deltas() {
    let m = mock(|_| sse(frames(&[json!({ "reasoning_content": "Let me " }), json!({ "reasoning_content": "think." }), json!({ "reasoning": " More." }), json!({ "content": "Hello" }), json!({ "content": " wörld" })]))).await;
    let r = run(&m.url, None, json!({ "reasoning_effort": "high" }), None, &CancellationToken::new()).await;
    assert_eq!(r.out.unwrap(), Reply { reasoning: "Let me think. More.".into(), content: "Hello wörld".into(), ..Default::default() });
    assert!(r.deltas.len() >= 2);
    let body = m.reqs.lock().unwrap()[0].json();
    assert_eq!((body["stream"].clone(), body["reasoning_effort"].clone()), (json!(true), json!("high")));
    assert!(body.get("tools").is_none()); // without a search key nothing changes
}

#[tokio::test]
async fn splits_think_tags_across_chunks() {
    let m = mock(|_| sse(frames(&[json!({ "content": "<thi" }), json!({ "content": "nk>abc</th" }), json!({ "content": "ink>\n\nAnswer" })]))).await;
    let out = simple(&m.url).await.out.unwrap();
    assert_eq!((out.reasoning.as_str(), out.content.as_str()), ("abc", "Answer"));
    assert_eq!(ThinkSplitter::default().push("Use <think> tags", true), (String::new(), "Use <think> tags".into()));
}

#[tokio::test]
async fn plain_json_fallback() {
    let m = mock(|_| Answer::Full(200, "application/json", json!({ "choices": [{ "message": { "content": "hi", "reasoning_content": "r" } }] }).to_string())).await;
    let out = simple(&m.url).await.out.unwrap();
    assert_eq!((out.content.as_str(), out.reasoning.as_str()), ("hi", "r"));
}

#[tokio::test]
async fn http_errors_and_mid_stream_error_chunks_throw() {
    let m = mock(|_| Answer::Full(400, "application/json", r#"{"error":"bad level"}"#.into())).await;
    assert!(simple(&m.url).await.out.unwrap_err().to_string().contains("HTTP 400"));
    let m = mock(|_| sse("data: {\"error\":{\"message\":\"boom\"}}\n\n".into())).await;
    assert!(simple(&m.url).await.out.unwrap_err().to_string().contains("boom"));
}

#[tokio::test]
async fn keeps_partial_reply_when_stream_breaks_late() {
    let text = frames(&[json!({ "content": "Hel" }), json!({ "content": "lo" })]).replace("data: [DONE]\n\n", "");
    let m = mock(move |_| Answer::Sse { text: text.clone(), cut: true }).await;
    let out = simple(&m.url).await.out.unwrap();
    assert_eq!(out.content, "Hello");
    assert!(out.error.is_some());
    let m = mock(|_| Answer::Sse { text: String::new(), cut: true }).await;
    assert!(simple(&m.url).await.out.is_err()); // nothing arrived: an error, not an empty reply
}

#[tokio::test]
async fn stop_marks_partial_reply_and_stops_before_any_reply() {
    let m = mock(|_| Answer::Slow(vec![frames(&[json!({ "content": "part" })]).replace("data: [DONE]\n\n", ""), frames(&[json!({ "content": " more" })])])).await;
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let mut got = String::new();
    let out = chat_stream(&Client::new(), &m.url, "", "m", vec![], json!({}), &mut |d| { got += &d.content; c2.cancel(); }, &cancel, None).await.unwrap();
    assert_eq!(out, Reply { content: "part".into(), stopped: true, ..Default::default() });
    let pre = CancellationToken::new();
    pre.cancel();
    let m = mock(|_| Answer::Hang).await;
    assert_eq!(run(&m.url, None, json!({}), None, &pre).await.out.unwrap_err().to_string(), "Stopped");
    // stopped while waiting for the server to answer
    let c = CancellationToken::new();
    let c3 = c.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        c3.cancel();
    });
    assert_eq!(run(&m.url, None, json!({}), None, &c).await.out.unwrap_err().to_string(), "Stopped");
}

#[tokio::test]
async fn no_content_204_is_fine_for_models() {
    let m = mock(|_| Answer::Full(204, "application/json", String::new())).await;
    // an empty body is not JSON
    assert!(list_models_detailed(&Client::new(), &m.url, "").await.unwrap_err().to_string().contains("didn't return JSON"));
}

// ---- web search (Linkup) ----
/// Routes by path: /linkup is answered by `linkup`, chat calls pop the next reply from `replies`.
async fn search_mock(replies: Vec<Answer>, linkup: impl Fn() -> Answer + Send + Sync + 'static) -> (Mock, Search) {
    let q = Mutex::new(VecDeque::from(replies));
    let m = mock(move |r| if r.path == "/linkup" { linkup() } else { q.lock().unwrap().pop_front().expect("no reply left") }).await;
    let s = Search { key: "lk-1".into(), url: format!("{}/linkup", m.url) };
    (m, s)
}
fn chats(m: &Mock) -> Vec<Value> {
    m.reqs.lock().unwrap().iter().filter(|r| r.path != "/linkup").map(Req::json).collect()
}
fn hits(m: &Mock) -> Vec<Req> {
    m.reqs.lock().unwrap().iter().filter(|r| r.path == "/linkup").cloned().collect()
}
fn linkup_ok(results: Value) -> impl Fn() -> Answer + Send + Sync + 'static {
    move || Answer::Full(200, "application/json", json!({ "results": results }).to_string())
}
fn one_call(args: &str) -> String {
    tool_frames(&[json!([{ "index": 0, "id": "c", "function": { "name": "web_search", "arguments": args } }])])
}

#[tokio::test]
async fn search_streamed_tool_call_runs_one_search_then_answers() {
    let replies = vec![
        sse(tool_frames(&[
            json!([{ "index": 0, "id": "c1", "function": { "name": "web_search", "arguments": "" } }]),
            json!([{ "index": 0, "function": { "arguments": "{\"query\":\"paris " } }]),
            json!([{ "index": 0, "function": { "arguments": "weather\"}" } }]),
        ])),
        sse(frames(&[json!({ "content": "Sunny." })])),
    ];
    let results = json!([{ "type": "text", "name": "Meteo", "url": "https://m.example", "content": "Sunny, 21C", "favicon": "" }, { "type": "image", "name": "pic", "url": "https://i.example" }]);
    let (m, s) = search_mock(replies, linkup_ok(results)).await;
    let r = run(&m.url, None, json!({}), Some(&s), &CancellationToken::new()).await;
    assert_eq!(r.out.unwrap(), Reply { content: "Sunny.".into(), reasoning: "Searching the web: paris weather\n".into(), ..Default::default() });
    let h = hits(&m);
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].auth, "Bearer lk-1");
    assert_eq!(h[0].json(), json!({ "q": "paris weather", "depth": "fast", "outputType": "searchResults", "maxResults": 5 }));
    let c = chats(&m);
    assert_eq!((c[0]["tools"][0]["function"]["name"].clone(), c[0]["tool_choice"].clone()), (json!("web_search"), json!("auto")));
    let (asst, tool) = (&c[1]["messages"][1], &c[1]["messages"][2]);
    assert_eq!(asst["tool_calls"][0], json!({ "id": "c1", "type": "function", "function": { "name": "web_search", "arguments": "{\"query\":\"paris weather\"}" } }));
    assert_eq!((tool["role"].clone(), tool["tool_call_id"].clone()), (json!("tool"), json!("c1")));
    let tc = tool["content"].as_str().unwrap();
    assert!(tc.contains("Meteo\nhttps://m.example\nSunny, 21C") && !tc.contains("pic"));
    assert!(r.deltas.iter().any(|d| d.reasoning.starts_with("Searching the web")));
}

#[tokio::test]
async fn search_round_cap_forces_answer_and_failed_search_becomes_tool_text() {
    let replies = (0..5).map(|_| sse(one_call("{\"query\":\"q\"}"))).collect();
    let (m, s) = search_mock(replies, || Answer::Full(500, "text/plain", "down".into())).await;
    let out = run(&m.url, None, json!({}), Some(&s), &CancellationToken::new()).await.out.unwrap();
    let c = chats(&m);
    assert_eq!(c.len(), 5); // 4 search rounds + the forced final one
    assert_eq!((c[3]["tool_choice"].clone(), c[4]["tool_choice"].clone()), (json!("auto"), json!("none")));
    assert!(c[4].get("tools").is_some());
    let last = c[1]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_string();
    assert!(last.contains("Search failed: Linkup HTTP 500"), "{last}");
    assert_eq!(out.content, "");
}

#[tokio::test]
async fn search_bad_arguments_reported_never_reach_linkup() {
    let (m, s) = search_mock(vec![sse(one_call("{oops")), sse(frames(&[json!({ "content": "ok" })]))], linkup_ok(json!([]))).await;
    assert_eq!(run(&m.url, None, json!({}), Some(&s), &CancellationToken::new()).await.out.unwrap().content, "ok");
    let c = chats(&m);
    assert_eq!(c[1]["messages"][1]["tool_calls"][0]["id"], "c");
    assert_eq!(c[1]["messages"][2], json!({ "role": "tool", "tool_call_id": "c", "content": "Error: call web_search with a JSON object like {\"query\": \"...\"}." }));
    assert!(hits(&m).is_empty());
}

#[tokio::test]
async fn search_stop_while_linkup_in_flight() {
    let (m, s) = search_mock(vec![sse(one_call("{\"query\":\"q\"}"))], || Answer::Hang).await;
    let cancel = CancellationToken::new();
    let (c2, reqs) = (cancel.clone(), m.reqs.clone());
    tokio::spawn(async move {
        while !reqs.lock().unwrap().iter().any(|r| r.path == "/linkup") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        c2.cancel(); // the request is now pending, not merely about to start
    });
    assert_eq!(run(&m.url, None, json!({}), Some(&s), &cancel).await.out.unwrap_err().to_string(), "Stopped");
}

#[tokio::test]
async fn search_reasoning_goes_back_only_on_thinking_providers() {
    for (thinking, expected) in [(true, Some("plan the search")), (false, None)] {
        let call = format!("data: {}\n\n", json!({ "choices": [{ "delta": { "reasoning_content": "plan the search" } }] })) + &one_call("{\"query\":\"q\"}");
        let (m, s) = search_mock(vec![sse(call), sse(frames(&[json!({ "content": "done" })]))], linkup_ok(json!([]))).await;
        // the endpoint's host decides; route a deepseek-looking path to the mock (the regex matches anywhere in the URL)
        let ep = if thinking { format!("{}/deepseek.com", m.url) } else { m.url.clone() };
        run(&m.url, Some(&ep), json!({}), Some(&s), &CancellationToken::new()).await.out.unwrap();
        assert_eq!(chats(&m)[1]["messages"][1].get("reasoning_content").and_then(Value::as_str), expected);
    }
}

#[tokio::test]
async fn search_at_most_four_requests_even_in_parallel() {
    let two = tool_frames(&[json!([
        { "index": 0, "id": "a", "function": { "name": "web_search", "arguments": "{\"query\":\"one\"}" } },
        { "index": 1, "id": "b", "function": { "name": "web_search", "arguments": "{\"query\":\"two\"}" } },
    ])]);
    let replies = vec![sse(two.clone()), sse(two.clone()), sse(two), sse(frames(&[json!({ "content": "ok" })]))];
    let (m, s) = search_mock(replies, linkup_ok(json!([]))).await;
    assert_eq!(run(&m.url, None, json!({}), Some(&s), &CancellationToken::new()).await.out.unwrap().content, "ok");
    assert_eq!(hits(&m).len(), 4);
    let tools: Vec<Value> = chats(&m)[3]["messages"].as_array().unwrap().iter().filter(|x| x["role"] == "tool").cloned().collect();
    assert_eq!(tools.len(), 6);
    for t in &tools[4..] {
        assert_eq!(t["content"], "Search limit reached. Answer with what you already have.");
    }
}

#[tokio::test]
async fn search_non_streaming_reply_with_tool_calls() {
    let first = json!({ "choices": [{ "message": { "content": "", "tool_calls": [{ "id": "c", "function": { "name": "web_search", "arguments": "{\"query\":\"q\"}" } }] } }] }).to_string();
    let second = json!({ "choices": [{ "message": { "content": "done" } }] }).to_string();
    let (m, s) = search_mock(vec![Answer::Full(200, "application/json", first), Answer::Full(200, "application/json", second)], linkup_ok(json!([]))).await;
    assert_eq!(run(&m.url, None, json!({}), Some(&s), &CancellationToken::new()).await.out.unwrap().content, "done");
    assert_eq!(chats(&m)[1]["messages"].as_array().unwrap().last().unwrap()["content"], "No results.");
}
