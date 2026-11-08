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

/// Wording offering the downloaded version.
pub fn update_available(version: &str) -> String {
    match language().as_str() {
        "pt" => format!("A versão {version} do Verboo Code está disponível. Baixar e reiniciar agora?"),
        "zh" => format!("Verboo Code {version} 已发布。是否立即下载并重启？"),
        "ja" => format!("Verboo Code {version} が公開されました。今すぐダウンロードして再起動しますか？"),
        "es" => format!("La versión {version} de Verboo Code está disponible. ¿Descargar y reiniciar ahora?"),
        "fr" => format!("La version {version} de Verboo Code est disponible. Télécharger et redémarrer maintenant ?"),
        "de" => format!("Verboo Code {version} ist verfügbar. Jetzt herunterladen und neu starten?"),
        "ru" => format!("Доступна версия Verboo Code {version}. Загрузить и перезапустить сейчас?"),
        _ => format!("Verboo Code {version} is available. Download and restart now?"),
    }
}

/// Label of the button that installs the update.
pub fn update_install() -> &'static str {
    match language().as_str() {
        "pt" => "Baixar e reiniciar",
        "zh" => "下载并重启",
        "ja" => "ダウンロードして再起動",
        "es" => "Descargar y reiniciar",
        "fr" => "Télécharger et redémarrer",
        "de" => "Herunterladen und neu starten",
        "ru" => "Загрузить и перезапустить",
        _ => "Download and restart",
    }
}

/// Label of the button that keeps the installed version.
pub fn update_later() -> &'static str {
    match language().as_str() {
        "pt" => "Depois",
        "zh" => "以后",
        "ja" => "後で",
        "es" => "Más tarde",
        "fr" => "Plus tard",
        "de" => "Später",
        "ru" => "Позже",
        _ => "Later",
    }
}
