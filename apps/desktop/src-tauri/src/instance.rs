//! `make dev` runs an isolated AstrLink beside the one started with
//! `make start` or installed. Its identifier, set by `tauri.dev.conf.json`,
//! gives it separate data and config directories and its own single-instance
//! lock. This module picks the rest: the home its clients and agent tools
//! are set up in, the default inference port, the link scheme and the name
//! of its login item.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use crate::{
    agent_home::{Home, Homes},
    agent_install, wsl,
};

pub const ISOLATED_IDENTIFIER: &str = "com.astrlink.desktop.isolated";
pub const ISOLATED_NAME: &str = "AstrLink Dev";
pub const ISOLATED_LINK_SCHEME: &str = "astrlink-isolated";
pub const LINK_SCHEME: &str = "astrlink";
const ISOLATED_INFERENCE_PORT: u16 = 18318;
/// The isolated instance's own home, inside the user's.
const ISOLATED_HOME: &str = ".astrlink-isolated";

static ISOLATED: AtomicBool = AtomicBool::new(false);

/// Applies the identity the build was configured with. Plugins read the link
/// schemes and the product name, which names the login item, when the app is
/// built.
pub fn configure<R: tauri::Runtime>(mut context: tauri::Context<R>) -> tauri::Context<R> {
    if context.config().identifier == ISOLATED_IDENTIFIER {
        ISOLATED.store(true, Ordering::Relaxed);
        isolate(context.config_mut());
        context.package_info_mut().name = ISOLATED_NAME.to_string();
    }
    context
}

/// Registers the isolated link scheme in place of the shared one.
fn isolate(config: &mut tauri::Config) {
    if let Some(schemes) = config
        .plugins
        .0
        .get_mut("deep-link")
        .and_then(|deep_link| deep_link.pointer_mut("/desktop/schemes"))
    {
        *schemes = serde_json::json!([ISOLATED_LINK_SCHEME]);
    }
}

pub fn is_isolated() -> bool {
    ISOLATED.load(Ordering::Relaxed)
}

/// The name this instance goes by, as its login item and app bundle show it.
pub fn product_name() -> &'static str {
    if is_isolated() {
        ISOLATED_NAME
    } else {
        "AstrLink"
    }
}

/// The home whose client configs, agent tools and agent locator this
/// instance manages. The isolated instance sets them up in its own home,
/// laid out like the user's, so trying them never repoints the clients the
/// other AstrLink serves. A client started with HOME set to it reaches the
/// isolated gateway.
pub fn agent_home(user_home: PathBuf) -> PathBuf {
    if is_isolated() {
        user_home.join(ISOLATED_HOME)
    } else {
        user_home
    }
}

/// Gives the isolated home a directory for each agent tool installed for
/// the user, so the tools are detected there and can be set up. Nothing in
/// the user's tool directories is copied.
pub fn prepare_home(user_home: &Path) -> Result<(), String> {
    if !is_isolated() {
        return Ok(());
    }
    let home = user_home.join(ISOLATED_HOME);
    fs::create_dir_all(&home)
        .map_err(|error| format!("unable to create {}: {error}", home.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&home, fs::Permissions::from_mode(0o700));
    }
    let user = Homes::find(user_home.to_path_buf(), wsl::Reach::Named(&[]))?
        .take(None)
        .ok_or_else(|| "the user's home is unavailable".to_string())?;
    agent_install::mirror_tools(user.home(), Home::local(&home))
        .map_err(|error| format!("unable to prepare {}: {error}", home.display()))
}

pub fn default_inference_port() -> u16 {
    if is_isolated() {
        ISOLATED_INFERENCE_PORT
    } else {
        crate::preferences::DEFAULT_INFERENCE_PORT
    }
}

pub fn link_scheme() -> &'static str {
    if is_isolated() {
        ISOLATED_LINK_SCHEME
    } else {
        LINK_SCHEME
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dev_config_selects_the_isolated_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert_eq!(config["identifier"], ISOLATED_IDENTIFIER);
    }

    #[test]
    fn the_shared_instance_goes_by_the_configured_product_name() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["productName"], product_name());
    }

    #[test]
    fn the_isolated_identity_registers_its_own_link_scheme() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config.plugins.0["deep-link"]["desktop"]["schemes"],
            serde_json::json!([LINK_SCHEME])
        );
        isolate(&mut config);
        assert_eq!(
            config.plugins.0["deep-link"]["desktop"]["schemes"],
            serde_json::json!([ISOLATED_LINK_SCHEME])
        );
    }
}
