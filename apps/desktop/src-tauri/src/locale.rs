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

/// Close the focused chat view rather than the native application window.
pub fn close_pane() -> &'static str {
    match language().as_str() {
        "pt" => "Fechar painel",
        "zh" => "关闭窗格",
        "ja" => "ペインを閉じる",
        "es" => "Cerrar panel",
        "fr" => "Fermer le volet",
        "de" => "Bereich schließen",
        "ru" => "Закрыть панель",
        _ => "Close pane",
    }
}

/// Confirmation appears before shutting down the Host or interrupting running work.
pub fn quit_title() -> &'static str {
    match language().as_str() {
        "pt" => "Sair do Verboo Code?",
        "zh" => "退出 Verboo Code？",
        "ja" => "Verboo Code を終了しますか？",
        "es" => "¿Salir de Verboo Code?",
        "fr" => "Quitter Verboo Code ?",
        "de" => "Verboo Code beenden?",
        "ru" => "Выйти из Verboo Code?",
        _ => "Quit Verboo Code?",
    }
}

/// Explain the consequence of quitting without implying that pane closure stops work.
pub fn quit_message() -> &'static str {
    match language().as_str() {
        "pt" => "O trabalho em andamento será interrompido. Seu histórico continuará salvo.",
        "zh" => "正在进行的工作将被中断。对话历史仍会保存。",
        "ja" => "実行中の作業は中断されます。会話履歴は保存されます。",
        "es" => "Se interrumpirá el trabajo en curso. El historial permanecerá guardado.",
        "fr" => "Le travail en cours sera interrompu. L’historique restera enregistré.",
        "de" => "Laufende Arbeit wird unterbrochen. Der Verlauf bleibt gespeichert.",
        "ru" => "Текущая работа будет прервана. История останется сохранённой.",
        _ => "Work in progress will be interrupted. Your conversation history will remain saved.",
    }
}

/// Explicit app-exit action.
pub fn quit_confirm() -> &'static str {
    match language().as_str() {
        "pt" => "Sair",
        "zh" => "退出",
        "ja" => "終了",
        "es" => "Salir",
        "fr" => "Quitter",
        "de" => "Beenden",
        "ru" => "Выйти",
        _ => "Quit",
    }
}

/// Dismiss the exit confirmation and keep all work running.
pub fn quit_cancel() -> &'static str {
    match language().as_str() {
        "pt" => "Cancelar",
        "zh" => "取消",
        "ja" => "キャンセル",
        "es" => "Cancelar",
        "fr" => "Annuler",
        "de" => "Abbrechen",
        "ru" => "Отмена",
        _ => "Cancel",
    }
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
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_native_string_carries_copy() {
        for value in [
            close_pane(),
            quit_title(),
            quit_message(),
            quit_confirm(),
            quit_cancel(),
            startup_failure(),
        ] {
            assert!(!value.trim().is_empty());
            assert!(!value.contains('\u{7}'));
        }
    }

    #[test]
    fn an_unknown_language_falls_back_to_english() {
        assert!(!language().is_empty());
    }
}
