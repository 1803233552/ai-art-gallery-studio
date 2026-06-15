#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use base64::Engine;
use reqwest::header;

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT_START: u16 = 18100;
const BACKEND_PORT_END: u16 = 18149;
const APP_DATA_DIR_NAME: &str = "AI Art Gallery Studio";
const TAURI_IDENTIFIER: &str = "com.aiartgallery.studio";
const BACKEND_PORT_FILE: &str = "backend-port.txt";
const REGISTRATION_URL: &str = "https://newapi.qianye.host/register?aff=uk7G";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct BackendProcess(Mutex<Option<CommandChild>>);

#[cfg(windows)]
fn terminate_process_tree(pid: u32) {
    let pid_arg = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid_arg.as_str(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn terminate_process_tree(_pid: u32) {}

fn stop_backend_process(process: &BackendProcess) {
    let child = process.0.lock().unwrap().take();
    if let Some(child) = child {
        terminate_process_tree(child.pid());
        let _ = child.kill();
    }
}

fn install_data_dir() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
}

fn desktop_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return env::var_os("APPDATA").map(|base| PathBuf::from(base).join(APP_DATA_DIR_NAME));
    }

    #[cfg(not(windows))]
    {
        None
    }
}

fn persisted_port_path() -> Option<PathBuf> {
    desktop_data_dir().map(|dir| dir.join(BACKEND_PORT_FILE))
}

fn port_in_range(port: u16) -> bool {
    (BACKEND_PORT_START..=BACKEND_PORT_END).contains(&port)
}

fn is_port_free(port: u16) -> bool {
    TcpListener::bind((BACKEND_HOST, port)).is_ok()
}

fn read_persisted_port() -> Option<u16> {
    let text = fs::read_to_string(persisted_port_path()?).ok()?;
    let port = text.trim().parse::<u16>().ok()?;
    port_in_range(port).then_some(port)
}

fn persist_backend_port(port: u16) {
    if let Some(dir) = desktop_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join(BACKEND_PORT_FILE), port.to_string());
    }
}

fn webview_indexeddb_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return env::var_os("LOCALAPPDATA").map(|base| {
            PathBuf::from(base)
                .join(TAURI_IDENTIFIER)
                .join("EBWebView")
                .join("Default")
                .join("IndexedDB")
        });
    }

    #[cfg(not(windows))]
    {
        None
    }
}

fn port_from_indexeddb_name(name: &str) -> Option<u16> {
    let rest = name.strip_prefix("http_127.0.0.1_")?;
    let port_text = rest.split('.').next()?;
    let port = port_text.parse::<u16>().ok()?;
    port_in_range(port).then_some(port)
}

fn discover_webview_storage_ports() -> Vec<u16> {
    let Some(dir) = webview_indexeddb_dir() else {
        return Vec::new();
    };

    let mut entries: Vec<(u16, u64)> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|it| it.filter_map(Result::ok))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let port = port_from_indexeddb_name(&name)?;
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some((port, modified))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter_map(|(port, _)| seen.insert(port).then_some(port))
        .collect()
}

fn find_free_port() -> u16 {
    if let Some(port) = read_persisted_port() {
        if is_port_free(port) {
            return port;
        }
    }

    // localStorage / IndexedDB 按完整 origin 隔离，端口变化会让 API Key 和历史图片“看起来丢失”。
    // 优先复用已有 WebView 存储目录对应的端口，兼容旧安装版曾经使用过的 18101 等端口。
    for port in discover_webview_storage_ports() {
        if is_port_free(port) {
            return port;
        }
    }

    for port in BACKEND_PORT_START..=BACKEND_PORT_END {
        if is_port_free(port) {
            return port;
        }
    }
    BACKEND_PORT_START
}

fn wait_for_backend(window: tauri::WebviewWindow, port: u16) {
    thread::spawn(move || {
        for _ in 0..180 {
            if TcpStream::connect((BACKEND_HOST, port)).is_ok() {
                if let Ok(url) = Url::parse(&format!("http://{BACKEND_HOST}:{port}/play")) {
                    let _ = window.navigate(url);
                }
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }

        let _ = window.eval(
            r#"
            document.body.innerHTML = '<main style="font-family:system-ui;padding:32px;line-height:1.7">\
              <h1>后端启动失败</h1>\
              <p>本地服务没有在 90 秒内启动，请查看应用日志或重新启动应用。</p>\
            </main>';
            "#,
        );
    });
}

#[tauri::command]
fn save_image_file(filename: String, base64_data: String) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|err| format!("图片数据解析失败：{err}"))?;

    let safe_filename = filename
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => ch,
        })
        .collect::<String>();
    let default_name = if safe_filename.to_ascii_lowercase().ends_with(".png") {
        safe_filename
    } else {
        format!("{safe_filename}.png")
    };

    let Some(path) = rfd::FileDialog::new()
        .set_title("保存图片")
        .set_file_name(&default_name)
        .add_filter("PNG 图片", &["png"])
        .save_file()
    else {
        return Ok(None);
    };

    fs::write(&path, bytes).map_err(|err| format!("写入文件失败：{err}"))?;
    Ok(Some(path.display().to_string()))
}

fn normalize_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

fn decode_image_data(value: &str) -> Result<Vec<u8>, String> {
    let raw = value
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(value)
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();

    base64::engine::general_purpose::STANDARD
        .decode(&raw)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&raw))
        .map_err(|err| format!("参考图解析失败：{err}"))
}

fn format_error_chain(err: &(dyn Error + 'static)) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join("; caused by: ")
}

#[cfg(windows)]
fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    let attempts = [
        ("explorer.exe", vec![url]),
        ("cmd", vec!["/C", "start", "", url]),
        ("rundll32.exe", vec!["url.dll,FileProtocolHandler", url]),
    ];

    let mut errors = Vec::new();
    for (program, args) in attempts {
        match Command::new(program)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(err) => errors.push(format!("{program}: {err}")),
        }
    }

    Err(format!("打开注册网址失败：{}", errors.join("; ")))
}

#[cfg(target_os = "macos")]
fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("打开注册网址失败：{err}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url_with_system_browser(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("打开注册网址失败：{err}"))
}

#[tauri::command]
fn open_registration_url() -> Result<(), String> {
    open_url_with_system_browser(REGISTRATION_URL)
}

#[tauri::command]
async fn native_image_edit(
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    count: u32,
    options_json: String,
    ref_images: Vec<String>,
) -> Result<String, String> {
    let options: serde_json::Value =
        serde_json::from_str(&options_json).map_err(|err| format!("生成参数解析失败：{err}"))?;

    let mut form = reqwest::multipart::Form::new()
        .text("model", model)
        .text("prompt", prompt)
        .text("n", count.max(1).to_string());

    if let Some(map) = options.as_object() {
        for (key, value) in map {
            if value.is_null() {
                continue;
            }
            let text = value
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| value.to_string());
            form = form.text(key.clone(), text);
        }
    }

    for (index, image) in ref_images.into_iter().enumerate() {
        let bytes = decode_image_data(&image)?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(format!("ref_{index}.png"))
            .mime_str("image/png")
            .map_err(|err| format!("参考图 MIME 设置失败：{err}"))?;
        form = form.part("image", part);
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .read_timeout(Duration::from_secs(900))
        .http1_only()
        .pool_max_idle_per_host(0)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|err| format!("原生请求客户端创建失败：{}", format_error_chain(&err)))?;

    let url = format!("{}/v1/images/edits", normalize_base_url(&base_url));
    let resp = client
        .post(url)
        .bearer_auth(api_key)
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::CONNECTION, "close")
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("原生图生图请求失败：{}", format_error_chain(&err)))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|err| format!("原生图生图读取响应失败：{}", format_error_chain(&err)))?;

    if status.is_success() {
        Ok(text)
    } else if text.trim().is_empty() {
        Ok(format!(
            r#"{{"error":{{"message":"上游返回 HTTP {}","type":"native_upstream_error","code":{}}}}}"#,
            status.as_u16(),
            status.as_u16()
        ))
    } else {
        Ok(text)
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            save_image_file,
            native_image_edit,
            open_registration_url
        ])
        .setup(|app| {
            let backend_port = find_free_port();
            persist_backend_port(backend_port);
            let backend_port_arg = backend_port.to_string();
            let mut sidecar_args = vec![
                "--host".to_string(),
                BACKEND_HOST.to_string(),
                "--port".to_string(),
                backend_port_arg,
            ];
            if let Some(data_dir) = install_data_dir() {
                sidecar_args.push("--data-dir".to_string());
                sidecar_args.push(data_dir.display().to_string());
            }
            let sidecar = app.shell().sidecar("ai-studio-backend")?.args(sidecar_args);
            let (mut rx, child) = sidecar.spawn()?;

            *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            print!("{}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprint!("{}", String::from_utf8_lossy(&bytes));
                        }
                        _ => {}
                    }
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                wait_for_backend(window, backend_port);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<BackendProcess>();
                stop_backend_process(&state);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            let state = app_handle.state::<BackendProcess>();
            stop_backend_process(&state);
        }
        _ => {}
    });
}
