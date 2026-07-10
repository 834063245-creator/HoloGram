// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Identity & credentials — permission_ask_response + credential store.


#[tauri::command]
pub(crate) async fn permission_ask_response(
    request_id: String,
    allow: bool,
    remember: Option<bool>,
    rule_to_add: Option<String>,
    rule_behavior: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    crate::permissions::resolve_ask(&request_id, allow);

    if remember.unwrap_or(false) {
        if let Some(ref rule_str) = rule_to_add {
            if let Ok(ctx) = crate::utils::get_ctx(&state) {
                let behavior = rule_behavior.unwrap_or_else(|| "allow".into());
                ctx.add_session_rule(rule_str, &behavior);
                tracing::info!(
                    "[perm] session rule added: {} -> {}",
                    rule_str,
                    if allow { "allowed this operation" } else { "denied this operation" }
                );
            } else {
                tracing::warn!("[perm] remember=true but get_ctx failed — session rule NOT saved");
            }
        } else {
            tracing::warn!("[perm] remember=true but rule_to_add is None — frontend may have lost suggestions");
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn credential_store(provider: String, key: String) -> Result<(), String> {
    crate::credential::store_api_key(&provider, &key)
}

#[tauri::command]
pub(crate) fn credential_get(provider: String) -> Result<Option<String>, String> {
    crate::credential::get_api_key(&provider)
}

#[tauri::command]
pub(crate) fn credential_delete(provider: String) -> Result<(), String> {
    crate::credential::delete_api_key(&provider)
}

#[tauri::command]
pub(crate) fn credential_clear() -> Result<(), String> {
    crate::credential::clear_credentials()
}
