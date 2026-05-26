// Viridian Leaf - A free PDF viewer and editor
// Copyright (c) 2026 Viridian Intelligence Ltd. UK
// https://github.com/coffogit/Viridian-Leaf
// Licensed under MIT License

use std::env;
use tauri::Emitter;

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
