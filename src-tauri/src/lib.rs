// Viridian Leaf - A free PDF viewer and editor
// Copyright (c) 2026 Viridian Intelligence Ltd. UK
// https://github.com/Perspiqua/Viridian-Leaf
// Licensed under MIT License

use serde::{Deserialize, Serialize};
use std::env;
use tauri::Emitter;

#[derive(Debug, Deserialize, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct AiChatRequest {
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    temperature: f32,
    max_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
}

fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("AI base URL is required.".to_string());
    }
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("AI base URL must start with http:// or https://.".to_string());
    }
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{}/chat/completions", trimmed))
    }
}

fn is_local_ai_base_url(base_url: &str) -> bool {
    let normalized = base_url.trim().to_ascii_lowercase();
    normalized.starts_with("http://localhost")
        || normalized.starts_with("https://localhost")
        || normalized.starts_with("http://127.0.0.1")
        || normalized.starts_with("https://127.0.0.1")
        || normalized.starts_with("http://[::1]")
        || normalized.starts_with("https://[::1]")
}

fn ollama_tags_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("AI base URL is required.".to_string());
    }
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("AI base URL must start with http:// or https://.".to_string());
    }

    let root = trimmed
        .strip_suffix("/v1")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    Ok(format!("{}/api/tags", root))
}

#[tauri::command]
async fn ai_list_local_models(base_url: String) -> Result<Vec<String>, String> {
    if !is_local_ai_base_url(&base_url) {
        return Err("Local model discovery only supports localhost AI endpoints.".to_string());
    }

    let url = ollama_tags_url(&base_url)?;
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|err| format!("Could not contact local AI server: {}", err))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Local AI model list could not be read: {}", err))?;

    if !status.is_success() {
        return Err(format!(
            "Local AI server returned {} while listing models: {}",
            status.as_u16(),
            body.chars().take(300).collect::<String>()
        ));
    }

    let parsed: OllamaTagsResponse = serde_json::from_str(&body)
        .map_err(|err| format!("Local AI model list was not valid Ollama JSON: {}", err))?;
    Ok(parsed.models.into_iter().map(|model| model.name).collect())
}

#[tauri::command]
async fn ai_chat_completion(request: AiChatRequest) -> Result<String, String> {
    if request.api_key.trim().is_empty() && !is_local_ai_base_url(&request.base_url) {
        return Err("Add an AI API key in AI Settings first.".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("Add an AI model in AI Settings first.".to_string());
    }
    if request.messages.is_empty() {
        return Err("AI request has no messages.".to_string());
    }

    let url = chat_completions_url(&request.base_url)?;
    let payload = ChatCompletionRequest {
        model: request.model.trim(),
        messages: &request.messages,
        temperature: request.temperature.unwrap_or(0.2),
        max_tokens: request.max_tokens.unwrap_or(900),
    };

    let client = reqwest::Client::new();
    let mut request_builder = client.post(url).json(&payload);

    if !request.api_key.trim().is_empty() {
        request_builder = request_builder.bearer_auth(request.api_key.trim());
    }

    let response = request_builder
        .send()
        .await
        .map_err(|err| format!("AI request failed: {}", err))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("AI response could not be read: {}", err))?;

    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| body.chars().take(500).collect());
        return Err(format!(
            "AI provider returned {}: {}",
            status.as_u16(),
            detail
        ));
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|err| format!("AI response was not valid chat completion JSON: {}", err))?;
    parsed
        .choices
        .into_iter()
        .find_map(|choice| choice.message.content)
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "AI provider returned an empty response.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let args: Vec<String> = env::args().collect();
            // First arg is the exe path, second (if present) is the file to open
            if args.len() > 1 {
                let file_path = args[1].clone();
                // Only process if it looks like a PDF file path
                if file_path.to_lowercase().ends_with(".pdf") {
                    let app_handle = app.handle().clone();
                    // Emit event after a short delay to ensure frontend is ready
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        let _ = app_handle.emit("open-file", file_path);
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_chat_completion,
            ai_list_local_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
