#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    local_server_manager_lib::run()
}
