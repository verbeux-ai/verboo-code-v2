//! Native startup failure copy follows the operating system's language.
pub fn startup_failure() -> &'static str {
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".into());
    match locale.split(['-', '_']).next().unwrap_or("en") {
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
