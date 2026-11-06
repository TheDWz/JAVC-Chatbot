//! Minimal OpenAI-compatible client (port of api.js): model list, streamed replies, reasoning support and Linkup web search.
use anyhow::{Result, anyhow, bail};
use reqwest::{Client, Response};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// The HTTP client the app uses: 30 s to connect, and up to 5 minutes of silence while a reply streams.
pub fn client() -> Client {
    Client::builder().connect_timeout(Duration::from_secs(30)).read_timeout(Duration::from_secs(300)).build().expect("HTTP client")
}

/// A readable message for an error and its causes (reqwest's own message alone says little).
pub fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let m = s.to_string();
        if !out.contains(&m) {
            out = format!("{out}: {m}");
        }
        src = s.source();
    }
    out
}

/// Runs `f` unless `cancel` fires first, which gives "Stopped".
async fn or_stop<T>(cancel: &CancellationToken, f: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("Stopped"),
        r = f => r,
    }
}

/// An endpoint may carry a query (Azure-style `…/v1?api-version=2`), which must stay after the path we append.
fn join_url(endpoint: &str, path: &str) -> String {
    match endpoint.split_once('?') {
        Some((base, query)) => format!("{}{path}?{query}", base.trim_end_matches('/')),
        None => format!("{}{path}", endpoint.trim_end_matches('/')),
    }
}

async fn call(http: &Client, endpoint: &str, key: &str, path: &str, body: Option<&Value>, cancel: &CancellationToken) -> Result<Response> {
    let url = join_url(endpoint, path);
    let mut req = match body {
        Some(b) => http.post(url).header("Content-Type", "application/json").body(b.to_string()),
        None => http.get(url).header("Content-Type", "application/json"),
    };
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let res = or_stop(cancel, async { req.send().await.map_err(|e| anyhow!(chain(&e))) }).await?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = or_stop(cancel, async { Ok(res.text().await.unwrap_or_default()) }).await?;
        bail!("HTTP {status}: {}", text.chars().take(500).collect::<String>());
    }
    Ok(res)
}

fn parse_json(text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|_| anyhow!("The server didn't return JSON. Is the endpoint right?"))
}

/// What a model list says about a model.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub id: String,
    /// The levels the model reports; None = the endpoint doesn't say; Some(empty) is never produced.
    pub efforts: Efforts,
    pub mandatory: bool,
    pub default: Option<String>,
    /// The list carries OpenRouter-style `reasoning` metadata.
    pub meta: bool,
    /// false only when the list says so (supported_parameters without `tools`).
    pub tools: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub enum Efforts {
    Unknown,
    None,
    Levels(Vec<String>),
}

/// Only OpenRouter-style lists carry reasoning metadata; plain OpenAI /models does not.
fn model_info(m: &Value) -> ModelInfo {
    let id = m.get("id").map(|v| v.as_str().map_or(v.to_string(), str::to_string)).unwrap_or_default();
    let sp = m.get("supported_parameters").and_then(Value::as_array);
    let tools = !sp.is_some_and(|sp| !sp.iter().any(|p| p == "tools"));
    if let Some(r) = m.get("reasoning").filter(|r| r.is_object()) {
        // Some(empty) is never produced: a list with no string entries means "no levels", not "unknown"
        let levels = || r.get("supported_efforts").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>());
        let efforts = match levels() {
            Some(l) if l.is_empty() => Efforts::None,
            Some(l) => Efforts::Levels(l),
            None => Efforts::Unknown,
        };
        return ModelInfo {
            id,
            efforts,
            mandatory: r.get("mandatory") == Some(&Value::Bool(true)),
            default: r.get("default_effort").and_then(Value::as_str).map(String::from),
            meta: true,
            tools,
        };
    }
    let efforts = if sp.is_some_and(|sp| !sp.iter().any(|p| p == "reasoning" || p == "reasoning_effort")) { Efforts::None } else { Efforts::Unknown };
    ModelInfo { id, efforts, mandatory: false, default: None, meta: false, tools }
}

pub async fn list_models_detailed(http: &Client, endpoint: &str, key: &str) -> Result<Vec<ModelInfo>> {
    let cancel = CancellationToken::new();
    let res = call(http, endpoint, key, "/models", None, &cancel).await?;
    let json = parse_json(&res.text().await.map_err(|e| anyhow!(chain(&e)))?)?;
    let mut out: Vec<ModelInfo> = json.get("data").and_then(Value::as_array).map(|a| a.iter().map(model_info).collect()).unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

// DeepSeek, Z.ai (GLM) and Moonshot (Kimi) turn thinking off with thinking:{type:'disabled'}, not effort 'none'.
// Match only the hostname: a path that merely mentions the provider is a proxy, not the provider.
fn host_is(endpoint: &str, domain: &str) -> bool {
    url::Url::parse(endpoint).ok().and_then(|u| u.host_str().map(str::to_lowercase)).is_some_and(|h| h == domain || h.ends_with(&format!(".{domain}")))
}
fn thinking_host(endpoint: &str) -> bool {
    ["deepseek.com", "api.z.ai", "bigmodel.cn", "moonshot.ai", "moonshot.cn"].iter().any(|d| host_is(endpoint, d))
}
pub fn thinking_switch(endpoint: &str) -> bool {
    thinking_host(endpoint)
}
fn openrouter_host(endpoint: &str) -> bool {
    host_is(endpoint, "openrouter.ai")
}

/// Which request shape to use. A gateway whose model list carries OpenRouter-style `reasoning` metadata (meta)
/// is treated as OpenRouter-compatible, so custom gateway domains work; `format` overrides the guess.
fn resolve_format<'a>(format: &'a str, endpoint: &str, meta: bool) -> &'a str {
    if !format.is_empty() && format != "auto" {
        return format;
    }
    if meta || openrouter_host(endpoint) {
        return "openrouter";
    }
    if thinking_switch(endpoint) { "thinking" } else { "openai" }
}

pub fn reasoning_params(endpoint: &str, effort: &str, format: &str, meta: bool) -> Value {
    if effort.is_empty() {
        return json!({});
    }
    match resolve_format(format, endpoint, meta) {
        "openrouter" => json!({ "reasoning": { "effort": effort } }),
        "thinking" if effort == "none" => json!({ "thinking": { "type": "disabled" } }),
        // shortcut: Moonshot's thinking field isn't accepted by always-on models (k3), so only non-Moonshot gets an explicit enable; revisit if Kimi docs say otherwise
        "thinking" if host_is(endpoint, "moonshot.ai") || host_is(endpoint, "moonshot.cn") => json!({ "reasoning_effort": effort }),
        "thinking" => json!({ "reasoning_effort": effort, "thinking": { "type": "enabled" } }),
        _ => json!({ "reasoning_effort": effort }),
    }
}

/// Whether the round's reasoning must be echoed back: thinking providers, and any profile forced to the thinking format.
pub fn echoes_reasoning(endpoint: &str, format: &str, meta: bool) -> bool {
    thinking_switch(endpoint) || resolve_format(format, endpoint, meta) == "thinking"
}

/// Local R1-style models put reasoning in content as <think>…</think>. Only a block at the very start counts,
/// so an answer that merely mentions "<think>" is left alone. Tags may be split across stream chunks.
#[derive(Default)]
pub struct ThinkSplitter {
    mode: u8, // 0 start, 1 think, 2 done
    buf: String,
    after_close: bool, // </think> was consumed: the line breaks right after it belong to it, not to the answer
}
const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";
impl ThinkSplitter {
    /// Feeds a chunk; returns (reasoning, content) that can be shown now.
    pub fn push(&mut self, chunk: &str, flush: bool) -> (String, String) {
        self.buf.push_str(chunk);
        let mut reasoning = String::new();
        if self.mode == 0 {
            let t = self.buf.trim_start();
            if let Some(rest) = t.strip_prefix(OPEN) {
                self.mode = 1;
                self.buf = rest.to_string();
            } else if !flush && OPEN.starts_with(t) {
                return (String::new(), String::new()); // could still become <think>, wait for more
            } else {
                self.mode = 2;
            }
        }
        if self.mode == 1 {
            if let Some(i) = self.buf.find(CLOSE) {
                reasoning = self.buf[..i].to_string();
                self.buf = self.buf[i + CLOSE.len()..].to_string();
                self.mode = 2;
                self.after_close = true;
            } else {
                let mut keep = 0; // hold back a possible partial </think> at the end
                if !flush {
                    for k in (1..=(CLOSE.len() - 1).min(self.buf.len())).rev() {
                        if self.buf.is_char_boundary(self.buf.len() - k) && CLOSE.starts_with(&self.buf[self.buf.len() - k..]) {
                            keep = k;
                            break;
                        }
                    }
                }
                let cut = self.buf.len() - keep;
                let r = self.buf[..cut].to_string();
                self.buf = self.buf[cut..].to_string();
                return (r, String::new());
            }
        }
        // strip only line breaks: the answer's own indentation (an indented code block, say) is content
        let mut content = std::mem::take(&mut self.buf);
        if self.after_close && content.trim_start_matches(['\r', '\n']).is_empty() {
            content = String::new();
        } else if self.after_close {
            content = content.trim_start_matches(['\r', '\n']).to_string();
            self.after_close = false;
        }
        (reasoning, content)
    }
}

fn pick_reasoning(o: &Value) -> &str {
    o.get("reasoning_content").and_then(Value::as_str).or_else(|| o.get("reasoning").and_then(Value::as_str)).unwrap_or("")
}

/// Folds one streamed `reasoning_details` item into `details` by its `index` (missing = 0): text and summary grow,
/// every other field is overwritten by the newer value; an unknown index appends.
fn merge_detail(details: &mut Vec<Value>, item: &Value) {
    let idx = |v: &Value| v.get("index").and_then(Value::as_u64).unwrap_or(0);
    let Some(slot) = details.iter_mut().find(|d| idx(d) == idx(item)) else {
        details.push(item.clone());
        return;
    };
    let Some(dst) = slot.as_object_mut() else {
        *slot = item.clone(); // whatever was there wasn't mergeable
        return;
    };
    for (k, v) in item.as_object().into_iter().flatten() {
        let joined = matches!(k.as_str(), "text" | "summary")
            && v.as_str().is_some()
            && dst.get(k.as_str()).and_then(Value::as_str).is_some();
        let merged = if joined { format!("{}{}", dst[k.as_str()].as_str().unwrap(), v.as_str().unwrap()).into() } else { v.clone() };
        dst.insert(k.clone(), merged);
    }
}

/// A piece of a reply as it streams in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Delta {
    pub reasoning: String,
    pub content: String,
}
/// A whole reply. If the stream broke or was stopped after some text arrived, `error` or `stopped` is set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reply {
    pub content: String,
    pub reasoning: String,
    /// OpenRouter-style structured reasoning, needed by some models to continue after a tool call.
    pub details: Vec<Value>,
    pub error: Option<String>,
    pub stopped: bool,
}

// ---- Web search through Linkup (https://docs.linkup.so). The model asks for it with a web_search tool call. ----
pub const LINKUP_URL: &str = "https://api.linkup.so/v1/search";
fn search_tool() -> Value {
    json!({ "type": "function", "function": {
        "name": "web_search",
        "description": "Search the web for current information, recent events or facts you are unsure about. Returns titles, URLs and page excerpts.",
        "parameters": { "type": "object", "properties": { "query": { "type": "string", "description": "A natural-language search query" } }, "required": ["query"] },
    } })
}
const SEARCH_ROUNDS: usize = 4; // Linkup requests (and tool rounds) per reply; after that the model must answer

/// Web search settings for one reply: the Linkup key, and where Linkup is (tests point it elsewhere).
#[derive(Debug, Clone)]
pub struct Search {
    pub key: String,
    pub url: String,
    /// Whether the provider needs the round's reasoning echoed back with its tool calls.
    pub echo_reasoning: bool,
}
impl Search {
    pub fn linkup(key: String) -> Self {
        Search { key, url: LINKUP_URL.into(), echo_reasoning: false }
    }
}

async fn linkup_search(http: &Client, search: &Search, q: &str, cancel: &CancellationToken) -> Result<String> {
    let req = http
        .post(&search.url)
        .header("Content-Type", "application/json")
        .bearer_auth(&search.key)
        .body(json!({ "q": q, "depth": "fast", "outputType": "searchResults", "maxResults": 5 }).to_string());
    let text = or_stop(cancel, async {
        let res = req.send().await.map_err(|e| anyhow!(chain(&e)))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| anyhow!(chain(&e)))?;
        if !status.is_success() {
            bail!("Linkup HTTP {}: {}", status.as_u16(), text.chars().take(300).collect::<String>());
        }
        Ok(text)
    })
    .await?;
    let json: Value = serde_json::from_str(&text).map_err(|_| anyhow!("Linkup didn't return JSON"))?;
    let hits: Vec<&Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|r| r.get("type") == Some(&json!("text")) && r.get("content").is_some_and(|c| !c.is_null() && c != "")).collect())
        .unwrap_or_default();
    if hits.is_empty() {
        return Ok("No results.".into());
    }
    let str_of = |v: &Value| v.as_str().map_or_else(|| v.to_string(), str::to_string);
    // shortcut: 2000 characters per result keeps a search from flooding the context; raise it if answers come back too thin
    Ok(hits
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let content: String = str_of(&r["content"]).chars().take(2000).collect();
            format!("[{}] {}\n{}\n{content}", i + 1, r.get("name").map(str_of).unwrap_or_default(), r.get("url").map(str_of).unwrap_or_default())
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Text from one request: the think splitter, the running totals and the delta callback.
struct Emitter<'a> {
    split: ThinkSplitter,
    out: Reply,
    on_delta: &'a mut (dyn FnMut(Delta) + Send),
}
impl Emitter<'_> {
    fn emit(&mut self, reasoning: &str, content: &str, flush: bool) {
        let (r, c) = self.split.push(content, flush);
        let d = Delta { reasoning: format!("{reasoning}{r}"), content: c };
        if d.reasoning.is_empty() && d.content.is_empty() {
            return;
        }
        self.out.reasoning += &d.reasoning;
        self.out.content += &d.content;
        (self.on_delta)(d);
    }
}

#[allow(clippy::too_many_arguments)]
/// One streamed request. Tool calls the model makes are pushed onto `calls` as {id, type, function:{name, arguments}}.
async fn stream_once(
    http: &Client, endpoint: &str, key: &str, model: &str, messages: &[Value], extra: &Value, on_delta: &mut (dyn FnMut(Delta) + Send),
    cancel: &CancellationToken, calls: &mut Vec<Value>,
) -> Result<Reply> {
    let mut body = json!({ "model": model, "messages": messages });
    body.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
    body["stream"] = true.into();
    let mut res = call(http, endpoint, key, "/chat/completions", Some(&body), cancel).await?;
    let mut em = Emitter { split: ThinkSplitter::default(), out: Reply::default(), on_delta };

    // Some servers ignore stream:true and answer with plain JSON.
    let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if ctype.contains("application/json") {
        let text = or_stop(cancel, async { res.text().await.map_err(|e| anyhow!(chain(&e))) }).await?;
        let json = parse_json(&text)?;
        if let Some(e) = json.get("error").filter(|e| !e.is_null()) {
            bail!("{}", e.get("message").and_then(Value::as_str).map_or_else(|| e.to_string(), String::from));
        }
        let m = json.pointer("/choices/0/message").cloned().unwrap_or(json!({}));
        // content is null when the model refuses; the refusal text is the reply then
        em.emit(pick_reasoning(&m), m.get("content").and_then(Value::as_str).or_else(|| m.get("refusal").and_then(Value::as_str)).unwrap_or(""), true);
        em.out.details = m.get("reasoning_details").and_then(Value::as_array).cloned().unwrap_or_default();
        for c in m.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            calls.push(json!({ "id": c.get("id").cloned().unwrap_or(json!("")), "type": "function",
                "function": { "name": c.pointer("/function/name").and_then(Value::as_str).unwrap_or(""), "arguments": c.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("") } }));
        }
        return Ok(em.out);
    }

    let mut by_index: Vec<Option<Value>> = vec![]; // streamed tool calls arrive in pieces: id and name first, then the arguments text
    // what one line says: [DONE] ends the reply, a finish_reason only proves it ended on purpose
    #[derive(PartialEq)]
    enum End {
        No,
        Done,
        Finish,
    }
    let mut handle = |line: &[u8], em: &mut Emitter| -> Result<End> {
        let line = String::from_utf8_lossy(line);
        let line = line.trim();
        let Some(data) = line.strip_prefix("data:") else { return Ok(End::No) };
        let data = data.trim();
        if data == "[DONE]" {
            return Ok(End::Done);
        }
        let Ok(j) = serde_json::from_str::<Value>(data) else { return Ok(End::No) };
        if let Some(e) = j.get("error").filter(|e| !e.is_null()) {
            bail!("Stream error: {}", e.get("message").and_then(Value::as_str).map_or_else(|| e.to_string(), String::from));
        }
        let finish = if j.pointer("/choices/0/finish_reason").and_then(Value::as_str).is_some() { End::Finish } else { End::No };
        let d = j.pointer("/choices/0/delta").cloned().unwrap_or(json!({}));
        // content is null when the model refuses; the refusal text is the reply then
        em.emit(pick_reasoning(&d), d.get("content").and_then(Value::as_str).or_else(|| d.get("refusal").and_then(Value::as_str)).unwrap_or(""), false);
        for r in d.get("reasoning_details").and_then(Value::as_array).into_iter().flatten() {
            merge_detail(&mut em.out.details, r);
        }
        for t in d.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            let i = t.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if i > 64 {
                bail!("Bad tool call index from the provider"); // a hostile index would resize the Vec into memory exhaustion
            }
            if by_index.len() <= i {
                by_index.resize(i + 1, None);
            }
            let c = by_index[i].get_or_insert_with(|| json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
            if let Some(id) = t.get("id").and_then(Value::as_str).filter(|x| !x.is_empty()) {
                c["id"] = id.into();
            }
            // names arrive either split ("web_" then "search") or repeated whole in every chunk
            if let Some(n) = t.pointer("/function/name").and_then(Value::as_str).filter(|x| !x.is_empty())
                && c["function"]["name"] != *n
            {
                c["function"]["name"] = format!("{}{n}", c["function"]["name"].as_str().unwrap_or("")).into();
            }
            if let Some(a) = t.pointer("/function/arguments").and_then(Value::as_str) {
                let cur = c["function"]["arguments"].as_str().unwrap_or("").to_string();
                c["function"]["arguments"] = (cur + a).into();
            }
        }
        Ok(finish)
    };
    let mut buf: Vec<u8> = vec![];
    let mut cut: Option<Result<(), String>> = None; // Err(message) = broken, Ok = stopped
    let read: Result<()> = async {
        let (mut end, mut finished) = (End::No, false);
        while end != End::Done {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => bail!("Stopped"),
                c = res.chunk() => c.map_err(|e| anyhow!(chain(&e)))?,
            };
            let Some(chunk) = chunk else { break };
            buf.extend_from_slice(&chunk);
            while end != End::Done && let Some(i) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=i).collect();
                end = handle(&line[..line.len() - 1], &mut em)?;
                finished |= end == End::Finish;
            }
        }
        if end != End::Done && !buf.is_empty() {
            end = handle(&std::mem::take(&mut buf), &mut em)?;
            finished |= end == End::Finish;
        }
        // the body ended without [DONE] and without a finish_reason: the reply was cut off before the end
        if end != End::Done && !finished {
            bail!("The reply ended early");
        }
        Ok(())
    }
    .await;
    if let Err(e) = read {
        em.emit("", "", true);
        if em.out.content.is_empty() {
            return Err(if cancel.is_cancelled() { anyhow!("Stopped") } else { e }); // nothing worth keeping
        }
        cut = Some(if cancel.is_cancelled() { Ok(()) } else { Err(e.to_string()) });
    }
    em.emit("", "", true); // flush anything the think splitter held back
    calls.extend(by_index.into_iter().flatten());
    let mut out = em.out;
    match cut {
        Some(Ok(())) => out.stopped = true,
        Some(Err(e)) => out.error = Some(e),
        None => {}
    }
    Ok(out)
}

/// Streams a reply. Without `search` this is a single request. With it, the model may call web_search up to SEARCH_ROUNDS times
/// before answering; text and reasoning from every round are joined. shortcut: the tool exchange stays inside this call and isn't
/// saved with the chat, so later turns see only the final answer, not the raw search results.
#[allow(clippy::too_many_arguments)]
pub async fn chat_stream(
    http: &Client, endpoint: &str, key: &str, model: &str, messages: Vec<Value>, extra: Value, on_delta: &mut (dyn FnMut(Delta) + Send),
    cancel: &CancellationToken, search: Option<&Search>,
) -> Result<Reply> {
    let Some(search) = search else { return stream_once(http, endpoint, key, model, &messages, &extra, on_delta, cancel, &mut vec![]).await };
    let mut total = Reply::default();
    let mut msgs = messages;
    let mut searches = 0; // Linkup requests so far in this reply, across rounds and parallel calls
    for round in 0.. {
        let last = round >= SEARCH_ROUNDS;
        let mut calls = vec![];
        let mut x = extra.clone();
        // tools stay in the request on the last round (tool_choice none): some backends reject tool messages when no tools are defined
        x["tools"] = json!([search_tool()]);
        x["tool_choice"] = (if last { "none" } else { "auto" }).into();
        let out = match stream_once(http, endpoint, key, model, &msgs, &x, on_delta, cancel, &mut calls).await {
            Ok(o) => o,
            Err(e) if !total.content.is_empty() => {
                Reply { stopped: cancel.is_cancelled(), error: (!cancel.is_cancelled()).then(|| e.to_string()), ..Default::default() }
            }
            Err(e) => return Err(e),
        };
        total.reasoning += &out.reasoning;
        total.content += &out.content;
        if out.error.is_some() || out.stopped || last || calls.is_empty() {
            total.error = out.error;
            total.stopped = out.stopped;
            return Ok(total);
        }
        // Thinking providers (and any profile forced to the thinking format) reject the follow-up with a 400 unless the round's reasoning goes back with its tool calls
        let mut asst = json!({ "role": "assistant", "content": out.content, "tool_calls": calls });
        if search.echo_reasoning && !out.reasoning.is_empty() {
            asst["reasoning_content"] = out.reasoning.clone().into();
        }
        if !out.details.is_empty() {
            asst["reasoning_details"] = out.details.clone().into(); // OpenRouter needs these to continue some models' tool calls
        }
        msgs.push(asst);
        for c in &calls {
            let q = serde_json::from_str::<Value>(c["function"]["arguments"].as_str().filter(|a| !a.is_empty()).unwrap_or("{}"))
                .ok()
                .and_then(|v| v.get("query").map(|q| q.as_str().map_or_else(|| if q.is_null() { String::new() } else { q.to_string() }, String::from)))
                .unwrap_or_default();
            let q = q.trim();
            let result = if c["function"]["name"] != "web_search" || q.is_empty() {
                r#"Error: call web_search with a JSON object like {"query": "..."}."#.to_string()
            } else if searches >= SEARCH_ROUNDS {
                "Search limit reached. Answer with what you already have.".to_string()
            } else {
                searches += 1;
                let note = format!("Searching the web: {q}\n");
                total.reasoning += &note;
                on_delta(Delta { reasoning: note, content: String::new() });
                match linkup_search(http, search, q, cancel).await {
                    Ok(r) => r,
                    Err(_) if cancel.is_cancelled() => {
                        if total.content.is_empty() {
                            bail!("Stopped");
                        }
                        total.stopped = true;
                        return Ok(total);
                    }
                    Err(e) => format!("Search failed: {e}"), // the model can still answer without it
                }
            };
            msgs.push(json!({ "role": "tool", "tool_call_id": c["id"], "content": result }));
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests;
