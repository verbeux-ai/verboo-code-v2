//! Native copy follows the operating system's language.
use sys_locale::get_locale;

/// Operating system language, with regional and script subtags removed.
fn language() -> String {
    get_locale()
        .unwrap_or_else(|| "en".into())
        .split(['-', '_'])
        .next()
        .unwrap_or("en")
        .to_string()
}

/// Startup failure copy.
pub fn startup_failure() -> &'static str {
    match language().as_str() {
        "pt" => "Não foi possível iniciar o Verboo Code. Feche o app e execute novamente o comando de desenvolvimento.",
        "zh" => "无法启动 Verboo Code。请关闭应用，然后重新运行桌面启动命令。",
        "ja" => "Verboo Code を起動できませんでした。アプリを閉じて、デスクトップの起動コマンドを再実行してください。",
        "es" => "No se pudo iniciar Verboo Code. Cierra la aplicación y vuelve a ejecutar el comando de escritorio.",
        "fr" => "Impossible de démarrer Verboo Code. Fermez l’application et relancez la commande de bureau.",
        "de" => "Verboo Code konnte nicht gestartet werden. Schließen Sie die App und starten Sie den Desktop-Befehl erneut.",
        "ru" => "Не удалось запустить Verboo Code. Закройте приложение и повторите команду запуска.",
        _ => "Verboo Code could not start. Close the app and run the desktop command again.",
    }
}

/// Wording for the update window, in both its offer and running states.
pub struct UpdateCopy {
    /// Heading while the update is offered.
    pub title: String,
    /// Explanation while the update is offered.
    pub body: String,
    /// Confirm button.
    pub install: String,
    /// Decline button.
    pub later: String,
    /// Heading while the download runs.
    pub running_title: String,
    /// Explanation while the download runs.
    pub running_body: String,
    /// Status line above the percentage.
    pub status: String,
    /// Dismiss button after a failed install.
    pub close: String,
    /// Message shown when the install fails.
    pub failed: String,
}

/// Copy for the update window offering `version`.
/// @param version - the version the feed announced.
/// @returns every string the window displays.
pub fn update_copy(version: &str) -> UpdateCopy {
    update_copy_in(&language(), version)
}

/// Copy for the update window in one language.
/// @param language - two-letter language of the operating system.
/// @param version - the version the feed announced.
/// @returns every string the window displays.
pub fn update_copy_in(language: &str, version: &str) -> UpdateCopy {
    match language {
        "pt" => UpdateCopy {
            title: "Atualização disponível".into(),
            body: format!("A versão {version} do Verboo Code está pronta para instalar. O app reinicia sozinho ao terminar."),
            install: "Baixar e reiniciar".into(),
            later: "Agora não".into(),
            running_title: "Atualizando o Verboo Code".into(),
            running_body: "Isso leva alguns instantes. O app reinicia assim que a instalação terminar.".into(),
            status: "Baixando".into(),
            close: "Fechar".into(),
            failed: "Não foi possível concluir a atualização.".into(),
        },
        "zh" => UpdateCopy {
            title: "有可用更新".into(),
            body: format!("Verboo Code {version} 已可安装。安装完成后应用会自动重启。"),
            install: "下载并重启".into(),
            later: "稍后".into(),
            running_title: "正在更新 Verboo Code".into(),
            running_body: "这需要一点时间。安装完成后应用会自动重启。".into(),
            status: "正在下载".into(),
            close: "关闭".into(),
            failed: "无法完成更新。".into(),
        },
        "ja" => UpdateCopy {
            title: "アップデートがあります".into(),
            body: format!("Verboo Code {version} をインストールできます。完了すると自動的に再起動します。"),
            install: "ダウンロードして再起動".into(),
            later: "後で".into(),
            running_title: "Verboo Code を更新しています".into(),
            running_body: "しばらくお待ちください。インストールが終わると自動的に再起動します。".into(),
            status: "ダウンロード中".into(),
            close: "閉じる".into(),
            failed: "アップデートを完了できませんでした。".into(),
        },
        "es" => UpdateCopy {
            title: "Actualización disponible".into(),
            body: format!("La versión {version} de Verboo Code está lista para instalarse. La aplicación se reinicia sola al terminar."),
            install: "Descargar y reiniciar".into(),
            later: "Ahora no".into(),
            running_title: "Actualizando Verboo Code".into(),
            running_body: "Esto tarda un momento. La aplicación se reinicia en cuanto termine la instalación.".into(),
            status: "Descargando".into(),
            close: "Cerrar".into(),
            failed: "No se pudo completar la actualización.".into(),
        },
        "fr" => UpdateCopy {
            title: "Mise à jour disponible".into(),
            body: format!("La version {version} de Verboo Code est prête à être installée. L’application redémarre seule à la fin."),
            install: "Télécharger et redémarrer".into(),
            later: "Plus tard".into(),
            running_title: "Mise à jour de Verboo Code".into(),
            running_body: "Cela prend un instant. L’application redémarre dès que l’installation est terminée.".into(),
            status: "Téléchargement".into(),
            close: "Fermer".into(),
            failed: "La mise à jour n’a pas pu aboutir.".into(),
        },
        "de" => UpdateCopy {
            title: "Update verfügbar".into(),
            body: format!("Verboo Code {version} kann installiert werden. Die App startet danach automatisch neu."),
            install: "Laden und neu starten".into(),
            later: "Später".into(),
            running_title: "Verboo Code wird aktualisiert".into(),
            running_body: "Das dauert einen Moment. Die App startet neu, sobald die Installation fertig ist.".into(),
            status: "Wird geladen".into(),
            close: "Schließen".into(),
            failed: "Das Update konnte nicht abgeschlossen werden.".into(),
        },
        "ru" => UpdateCopy {
            title: "Доступно обновление".into(),
            body: format!("Версия Verboo Code {version} готова к установке. По завершении приложение перезапустится само."),
            install: "Загрузить и перезапустить".into(),
            later: "Не сейчас".into(),
            running_title: "Обновление Verboo Code".into(),
            running_body: "Это займёт немного времени. Приложение перезапустится сразу после установки.".into(),
            status: "Загрузка".into(),
            close: "Закрыть".into(),
            failed: "Не удалось завершить обновление.".into(),
        },
        _ => UpdateCopy {
            title: "Update available".into(),
            body: format!("Verboo Code {version} is ready to install. The app restarts on its own when it finishes."),
            install: "Download and restart".into(),
            later: "Not now".into(),
            running_title: "Updating Verboo Code".into(),
            running_body: "This takes a moment. The app restarts as soon as the installation finishes.".into(),
            status: "Downloading".into(),
            close: "Close".into(),
            failed: "The update could not be completed.".into(),
        },
    }
}

/// Copy for the notice shown once an update has been applied.
/// @param version - the version now running.
/// @returns the heading and detail line for the notice.
pub fn updated_copy(version: &str) -> (String, String) {
    updated_copy_in(&language(), version)
}

/// Copy for the applied notice in one language.
/// @param language - two-letter language of the operating system.
/// @param version - the version now running.
/// @returns the heading and detail line for the notice.
pub fn updated_copy_in(language: &str, version: &str) -> (String, String) {
    match language {
        "pt" => ("Seu Verboo Code está atualizado!".into(), format!("Agora você está na versão {version}.")),
        "zh" => ("Verboo Code 已更新！".into(), format!("当前版本为 {version}。")),
        "ja" => ("Verboo Code が最新になりました！".into(), format!("現在のバージョンは {version} です。")),
        "es" => ("¡Tu Verboo Code está actualizado!".into(), format!("Ahora estás en la versión {version}.")),
        "fr" => ("Votre Verboo Code est à jour !".into(), format!("Vous êtes maintenant en version {version}.")),
        "de" => ("Dein Verboo Code ist aktuell!".into(), format!("Du bist jetzt auf Version {version}.")),
        "ru" => ("Ваш Verboo Code обновлён!".into(), format!("Теперь у вас версия {version}.")),
        _ => ("Your Verboo Code is up to date!".into(), format!("You are now on version {version}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every language the desktop ships copy for.
    const LANGUAGES: [&str; 7] = ["pt", "zh", "ja", "es", "fr", "de", "ru"];

    #[test]
    fn every_language_fills_every_update_string() {
        for language in LANGUAGES {
            let copy = update_copy_in(language, "1.2.3");
            for (field, value) in [
                ("title", &copy.title),
                ("body", &copy.body),
                ("install", &copy.install),
                ("later", &copy.later),
                ("running_title", &copy.running_title),
                ("running_body", &copy.running_body),
                ("status", &copy.status),
                ("close", &copy.close),
                ("failed", &copy.failed),
            ] {
                assert!(!value.trim().is_empty(), "{language} {field} is empty");
                // Control characters would break the injected script layout.
                assert!(!value.chars().any(|c| c.is_control() && c != '\n'), "{language} {field} has a control character");
            }
        }
    }

    #[test]
    fn the_offer_names_the_version_it_announces() {
        for language in LANGUAGES {
            let copy = update_copy_in(language, "9.9.9-rc.1");
            assert!(copy.body.contains("9.9.9-rc.1"), "{language} omits the version");
        }
    }

    #[test]
    fn the_applied_notice_names_the_running_version() {
        for language in LANGUAGES {
            let (title, body) = updated_copy_in(language, "9.9.9-rc.1");
            assert!(!title.trim().is_empty(), "{language} title empty");
            assert!(body.contains("9.9.9-rc.1"), "{language} omits the version");
        }
    }

    #[test]
    fn languages_do_not_fall_back_to_english() {
        let english = update_copy_in("en", "1.0.0").title;
        let mut distinct = 0;
        for language in LANGUAGES {
            if update_copy_in(language, "1.0.0").title != english {
                distinct += 1;
            }
        }
        // Each localized table states its own heading; only a missing table may
        // repeat the English one.
        assert_eq!(distinct, LANGUAGES.len(), "a language reuses the English heading");
    }

    #[test]
    fn an_unknown_language_falls_back_to_english() {
        assert_eq!(update_copy_in("xx", "1.0.0").title, "Update available");
        assert_eq!(updated_copy_in("xx", "1.0.0").0, "Your Verboo Code is up to date!");
    }

    /// The exact phrase each language uses to promise the automatic restart.
    const RESTART_PHRASE: [(&str, &str); 7] = [
        ("pt", "reinicia sozinho"),
        ("zh", "自动重启"),
        ("ja", "自動的に再起動"),
        ("es", "se reinicia sola"),
        ("fr", "redémarre seule"),
        ("de", "automatisch neu"),
        ("ru", "перезапустится"),
    ];

    #[test]
    fn every_language_promises_the_restart_before_the_download_starts() {
        // The point of the window: the user is told the app restarts on its own
        // before they confirm the download.
        for (language, phrase) in RESTART_PHRASE {
            let copy = update_copy_in(language, "1.0.0");
            assert!(
                copy.body.contains(phrase),
                "{language} must state the restart with '{phrase}': {}",
                copy.body,
            );
        }
        assert!(update_copy_in("en", "1.0.0").body.contains("restarts on its own"));
    }
}
