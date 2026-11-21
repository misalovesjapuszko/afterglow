//! Native Liquid Glass tab bar + mini player on iOS (UIGlassEffect, iOS 26+).
//! The web UI calls `plugin:glassbar|…`; on iOS Tauri forwards those calls to the Swift plugin.
//! Taps come back by the Swift side calling `window.__glassbar(name, value)` in the page.
use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_glassbar);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("glassbar")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_glassbar)?;
            Ok(())
        })
        .build()
}
