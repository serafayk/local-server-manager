use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

const ENGINE_READY_TIMEOUT: Duration = Duration::from_secs(20);
const AUTOSTART_TASK: &str = "Local Server Manager Engine";

static ENSURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn autostart_task_command(node: &Path, script: &Path) -> String {
    format!("\"{}\" \"{}\"", node.display(), script.display())
}

fn parse_engine_pid(text: &str) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get("pid")?.as_u64().and_then(|pid| u32::try_from(pid).ok())
}

/// `resource_dir()` pode vir com prefixo verbatim do Windows (`\\?\`), que o
/// Node não aceita como caminho de script. Remove o prefixo preservando UNC.
fn clean_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineApiInfo {
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub token: String,
    pub websocket_path: String,
}

fn data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("LSM_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("LocalServerManager")
}

fn engine_info_path() -> PathBuf {
    data_dir().join("engine").join("engine.json")
}

fn shell_log(message: &str) {
    use std::io::Write;
    let directory = data_dir().join("engine");
    let _ = fs::create_dir_all(&directory);
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("shell.log"))
    {
        let _ = writeln!(file, "[{epoch}] {message}");
    }
}

fn read_engine_api(path: &Path) -> Option<EngineApiInfo> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    serde_json::from_value(value.get("api")?.clone()).ok()
}

fn engine_is_reachable(info: &EngineApiInfo) -> bool {
    let Ok(address) = format!("{}:{}", info.host, info.port).parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok()
}

fn engine_assets(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_dir = clean_path(resource_dir);
        shell_log(&format!("resource_dir={}", resource_dir.display()));
        candidates.push(resource_dir.join("resources").join("engine"));
        candidates.push(resource_dir.join("engine"));
    }

    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("engine"),
    );

    for directory in candidates {
        let node = directory.join("node.exe");
        let script = directory.join("engine.mjs");
        shell_log(&format!(
            "candidate={} node={} script={}",
            directory.display(),
            node.is_file(),
            script.is_file()
        ));
        if node.is_file() && script.is_file() {
            return Some((node, script));
        }
    }
    None
}

fn spawn_engine(app: &AppHandle) -> Result<(), String> {
    let (node, script) =
        engine_assets(app).ok_or_else(|| {
            "Recursos do Engine não encontrados (node.exe + engine.mjs). \
             Execute `pnpm prepare:engine` antes de compilar o shell."
                .to_string()
        })?;

    let mut command = Command::new(&node);
    command.arg(&script);
    if let Some(parent) = script.parent() {
        command.current_dir(parent);
    }
    shell_log(&format!(
        "spawn node={} script={}",
        node.display(),
        script.display()
    ));

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    command
        .spawn()
        .map_err(|error| format!("Falha ao iniciar o Engine: {error}"))?;
    Ok(())
}

fn ensure_engine_blocking(app: &AppHandle) -> Result<EngineApiInfo, String> {
    let _guard = ENSURE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let info_path = engine_info_path();
    shell_log(&format!("ensure_engine data_dir={}", data_dir().display()));

    if let Some(info) = read_engine_api(&info_path) {
        if engine_is_reachable(&info) {
            shell_log("engine existente reutilizado");
            return Ok(info);
        }
        shell_log("engine.json orfao removido");
        let _ = fs::remove_file(&info_path);
    }

    spawn_engine(app)?;
    shell_log("engine spawn solicitado");

    let deadline = Instant::now() + ENGINE_READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(info) = read_engine_api(&info_path) {
            if engine_is_reachable(&info) {
                return Ok(info);
            }
        }
        thread::sleep(Duration::from_millis(150));
    }

    Err(format!(
        "O Engine não ficou pronto em {}s. Verifique {}\\engine.log",
        ENGINE_READY_TIMEOUT.as_secs(),
        data_dir().join("engine").display()
    ))
}

/// Garante que o Engine está rodando e devolve o endpoint autenticado.
#[tauri::command]
async fn ensure_engine(app: AppHandle) -> Result<EngineApiInfo, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_engine_blocking(&app))
        .await
        .map_err(|error| error.to_string())?
}

/// Diagnóstico: lê engine.json sem iniciar nada.
#[tauri::command]
fn engine_info() -> Option<EngineApiInfo> {
    read_engine_api(&engine_info_path())
}

fn read_engine_pid(path: &Path) -> Option<u32> {
    fs::read_to_string(path).ok().and_then(|text| parse_engine_pid(&text))
}

fn autostart_task_exists() -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("schtasks.exe")
            .args(["/Query", "/TN", AUTOSTART_TASK])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn autostart_status() -> bool {
    autostart_task_exists()
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let (node, script) = engine_assets(&app).ok_or_else(|| {
                "Recursos do Engine não encontrados; execute `pnpm prepare:engine`.".to_string()
            })?;
            let task_command = autostart_task_command(&node, &script);
            let output = Command::new("schtasks.exe")
                .args([
                    "/Create",
                    "/TN",
                    AUTOSTART_TASK,
                    "/SC",
                    "ONLOGON",
                    "/TR",
                    &task_command,
                    "/RL",
                    "LIMITED",
                    "/F",
                ])
                .output()
                .map_err(|error| format!("Falha ao executar schtasks: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "schtasks falhou: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            shell_log(&format!("autostart habilitado: {task_command}"));
            return Ok(true);
        }

        let _ = Command::new("schtasks.exe")
            .args(["/Delete", "/TN", AUTOSTART_TASK, "/F"])
            .output();
        shell_log("autostart desabilitado");
        Ok(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, enabled);
        Err("Autostart é suportado apenas no Windows".to_string())
    }
}

/// Reinicia o Engine (usado após agendar uma restauração de backup).
#[tauri::command]
async fn restart_engine(app: AppHandle) -> Result<EngineApiInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let info_path = engine_info_path();
        if let Some(pid) = read_engine_pid(&info_path) {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
            shell_log(&format!("restart_engine: pid {pid} encerrado"));
            thread::sleep(Duration::from_millis(500));
        }
        let _ = fs::remove_file(&info_path);
        ensure_engine_blocking(&app)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir painel", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair da interface", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Local Server Manager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            shell_log("setup iniciado");
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Fechar a janela não encerra o Engine nem os projetos.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            ensure_engine,
            engine_info,
            autostart_status,
            set_autostart,
            restart_engine
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar o Local Server Manager");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_command_quotes_both_paths() {
        let value = autostart_task_command(
            Path::new(r"C:\Program Files\nodejs\node.exe"),
            Path::new(r"C:\App\engine.mjs"),
        );
        assert_eq!(
            value,
            r#""C:\Program Files\nodejs\node.exe" "C:\App\engine.mjs""#
        );
    }

    #[test]
    fn parses_engine_pid_from_json() {
        assert_eq!(parse_engine_pid(r#"{"pid":4242,"protocolVersion":1}"#), Some(4242));
        assert_eq!(parse_engine_pid(r#"{"protocolVersion":1}"#), None);
        assert_eq!(parse_engine_pid("nao-json"), None);
    }
}
