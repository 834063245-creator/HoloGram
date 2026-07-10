// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Constraints — read/write hologram.constraints.yaml.

#[tauri::command]
pub(crate) async fn read_constraints(project_path: String) -> Result<String, String> {
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    if !yaml_path.exists() {
        let default_path = crate::utils::project_root().join("hologram.constraints.yaml");
        return std::fs::read_to_string(&default_path)
            .map_err(|e| format!("无法读取默认约束文件: {}", e));
    }
    std::fs::read_to_string(&yaml_path)
        .map_err(|e| format!("无法读取约束文件: {}", e))
}

#[tauri::command]
pub(crate) async fn write_constraints(project_path: String, content: String) -> Result<(), String> {
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    let tmp_path = yaml_path.with_extension("yaml.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("无法写入临时文件: {}", e))?;
    std::fs::rename(&tmp_path, &yaml_path)
        .map_err(|e| format!("无法保存约束文件: {}", e))?;
    Ok(())
}
