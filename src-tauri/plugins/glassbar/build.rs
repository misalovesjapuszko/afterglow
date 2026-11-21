// Commands are answered by the Swift side on iOS; on other systems nothing calls them.
const COMMANDS: &[&str] = &["configure", "tab", "track", "show"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
