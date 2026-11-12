//! Preserve native menus while routing Close to the focused conversation pane.
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle,
};

pub const CLOSE_PANE: &str = "verboo.close-pane";
pub const QUIT: &str = "verboo.quit";

/// Replace native Close window entries without changing editing or application commands.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let native_close = PredefinedMenuItem::close_window(app, None)?.text()?;
    let native_quit = PredefinedMenuItem::quit(app, None)?.text()?;
    let mut inserted = false;
    let mut quit_inserted = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            for (index, entry) in submenu.items()?.iter().enumerate().rev() {
                if let MenuItemKind::Predefined(predefined) = entry {
                    let text = plain_label(&predefined.text()?);
                    if text == plain_label(&native_quit) {
                        submenu.remove(entry)?;
                        submenu.insert(
                            &MenuItem::with_id(
                                app,
                                QUIT,
                                crate::locale::quit_confirm(),
                                true,
                                None::<&str>,
                            )?,
                            index,
                        )?;
                        quit_inserted = true;
                    } else if text == plain_label(&native_close) {
                        submenu.remove(entry)?;
                        if !inserted {
                            submenu.insert(
                                &MenuItem::with_id(
                                    app,
                                    CLOSE_PANE,
                                    crate::locale::close_pane(),
                                    true,
                                    Some("CmdOrCtrl+W"),
                                )?,
                                index,
                            )?;
                            inserted = true;
                        }
                    }
                }
            }
        }
    }
    if cfg!(any(target_os = "macos", target_os = "windows")) && (!inserted || !quit_inserted) {
        return Err(std::io::Error::other("native_close_or_quit_menu_missing").into());
    }
    if !inserted {
        menu.append(&Submenu::with_items(
            app,
            "File",
            true,
            &[
                &MenuItem::with_id(
                    app,
                    CLOSE_PANE,
                    crate::locale::close_pane(),
                    true,
                    Some("CmdOrCtrl+W"),
                )?,
                &MenuItem::with_id(app, QUIT, crate::locale::quit_confirm(), true, None::<&str>)?,
            ],
        )?)?;
    }
    Ok(menu)
}

/// Native backends strip mnemonic markers after attaching predefined items.
fn plain_label(text: &str) -> String {
    text.replace('&', "")
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_attached_and_unattached_native_labels() {
        assert_eq!(
            super::plain_label("C&lose Window"),
            super::plain_label("Close Window")
        );
        assert_eq!(super::plain_label("&Quit"), super::plain_label("Quit"));
    }
}
