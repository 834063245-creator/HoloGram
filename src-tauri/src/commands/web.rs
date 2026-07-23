// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Web search & fetch — Bing + DuckDuckGo + URL fetch.


const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

fn search_backend() -> &'static str {
    match std::env::var("HOLOGRAM_SEARCH_BACKEND").as_deref() {
        Ok("bing") => "bing",
        _ => "duckduckgo",
    }
}

#[tauri::command]
pub(crate) async fn web_search(
    query: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let backend = search_backend();
    let (search_url, q) = (match backend {
        "bing" => format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(&query)),
        _ => format!("https://html.duckduckgo.com/html/?q={}", crate::utils::urlencoding(&query)),
    }, query.clone());

    {
        let ctx = crate::utils::get_ctx(&state)?;
        let tool = crate::tools::WebFetchTool { url: search_url.clone() };
        crate::utils::check_permission(&tool, &ctx, &app).await?;
    }

    let results = match backend {
        "bing" => bing_search(&q)?,
        _ => duckduckgo_search(&q)?,
    };

    if results.is_empty() {
        return Ok(serde_json::json!({
            "query": query,
            "results": [],
            "error": "No results found.",
        }).to_string());
    }

    Ok(serde_json::json!({
        "query": query,
        "results": &results[..results.len().min(10)],
    }).to_string())
}

fn bing_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(query));

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(std::time::Duration::from_secs(5)))
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .build()
    );

    let resp = agent.get(&url)
        .header("User-Agent", CHROME_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .call()
        .map_err(|e| format!("web_search: request failed: {}", e))?;

    let mut body = resp.into_body();
    let html = body.read_to_string().map_err(|e| format!("web_search: read error: {}", e))?;

    let mut results = Vec::new();
    let block_re = regex::Regex::new(r#"<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)</li>"#).unwrap();
    let link_re = regex::Regex::new(r#"<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a></h2>"#).unwrap();
    let snippet_re = regex::Regex::new(r#"<p[^>]*>([\s\S]*?)</p>"#).unwrap();
    let tag_re = regex::Regex::new(r"<[^>]*>").unwrap();

    for cap in block_re.captures_iter(&html) {
        let block = &cap[1];
        if let Some(lc) = link_re.captures(block) {
            let title = tag_re.replace_all(&lc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re.captures_iter(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .find(|s| s.len() > 15)
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": lc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 { break; }
            }
        }
    }
    Ok(results)
}

fn duckduckgo_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let q = crate::utils::urlencoding(query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", q);

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(std::time::Duration::from_secs(5)))
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .build()
    );

    let resp = agent.get(&url)
        .header("User-Agent", CHROME_UA)
        .header("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .call()
        .map_err(|e| format!("web_search: request failed: {}", e))?;

    let mut body = resp.into_body();
    let html = body.read_to_string().map_err(|e| format!("web_search: read error: {}", e))?;

    let mut results = Vec::new();
    let title_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#
    ).unwrap();
    let snippet_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>"#
    ).unwrap();
    let tag_re = regex::Regex::new(r"<[^>]*>").unwrap();

    let split_re = regex::Regex::new(r#"<div[^>]*class="[^"]*result[^"]*"[^>]*>"#).unwrap();
    let blocks: Vec<&str> = split_re.split(&html).collect();

    for block in &blocks[1..] {
        if let Some(tc) = title_re.captures(block) {
            let title = tag_re.replace_all(&tc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re.captures(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": tc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 { break; }
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub(crate) async fn web_fetch(
    url: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    {
        let ctx = crate::utils::get_ctx(&state)?;
        let tool = crate::tools::WebFetchTool { url: url.clone() };
        crate::utils::check_permission(&tool, &ctx, &app).await?;
    }

    let parsed = url::Url::parse(&url).map_err(|e| format!("无效 URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("不支持的协议: {}", scheme));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || crate::utils::is_private_ip(host) {
        return Err("SSRF 防护: 不允许访问内网地址".to_string());
    }

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .http_status_as_error(false)
            .timeout_per_call(Some(std::time::Duration::from_secs(10)))
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .build()
    );

    let make_request =
        |ua: &str| -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
            agent.get(url.as_str())
                .header("User-Agent", ua)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,text/markdown;q=0.7,*/*;q=0.1")
                .header("Accept-Language", "en-US,en;q=0.9")
                .call()
        };

    let resp = match make_request(CHROME_UA) {
        Ok(r) if r.status().as_u16() != 403 => r,
        Ok(r) => {
            // 403 — check if Cloudflare challenge
            let is_cf = r.headers().get("cf-mitigated")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "challenge")
                .unwrap_or(false);
            if is_cf {
                make_request("opencode").map_err(|e| format!("请求失败 (Cloudflare blocked): {}", e))?
            } else {
                r
            }
        }
        Err(e) => return Err(format!("请求失败: {}", e)),
    };

    let content_type = resp.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let max_size: usize = 1 << 20;
    let mut body = String::new();
    let mut reader = resp.into_body().into_reader();
    let mut limited = (&mut reader).take(max_size as u64);
    use std::io::Read;
    limited.read_to_string(&mut body)
        .map_err(|e| format!("读取失败: {}", e))?;

    let text = body.clone();
    let truncated = body.len() >= max_size;

    let result = if content_type.contains("html") {
        let mut s = text;
        s = regex::Regex::new(r"(?si)<script[^>]*>.*?</script>").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?si)<style[^>]*>.*?</style>").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?s)<!--.*?-->").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"<[^>]*>").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
             .replace("&#x27;", "'").replace("&nbsp;", " ");
        s = regex::Regex::new(r"[ \t]+").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"\n{3,}").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, "\n\n").to_string();
        s.trim().to_string()
    } else {
        text
    };

    let mut info = String::new();
    if truncated {
        info.push_str("[内容已截断至 1 MiB]\n\n");
    }
    Ok(format!("{info}{result}"))
}
