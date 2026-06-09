use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT_START: u16 = 18100;
const BACKEND_PORT_END: u16 = 18149;

struct BackendProcess(Mutex<Option<CommandChild>>);

#[cfg(windows)]
fn terminate_process_tree(pid: u32) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
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

fn find_free_port() -> u16 {
    for port in BACKEND_PORT_START..=BACKEND_PORT_END {
        if TcpListener::bind((BACKEND_HOST, port)).is_ok() {
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

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            let backend_port = find_free_port();
            let backend_port_arg = backend_port.to_string();
            let sidecar = app
                .shell()
                .sidecar("ai-studio-backend")?
                .args(["--host", BACKEND_HOST, "--port", &backend_port_arg]);
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
