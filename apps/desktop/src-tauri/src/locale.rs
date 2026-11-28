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

pub fn update_install_wait() -> &'static str {
    match language().as_str() {
        "pt" => "Aguardando outra janela concluir a instalação da atualização…",
        "zh" => "正在等待另一个窗口完成更新安装…",
        "ja" => "別のウィンドウでのアップデートのインストールを待っています…",
        "es" => "Esperando a que otra ventana termine de instalar la actualización…",
        "fr" => "En attente de la fin de l’installation dans une autre fenêtre…",
        "de" => "Warten, bis ein anderes Fenster die Installation des Updates abgeschlossen hat…",
        "ru" => "Ожидание завершения установки обновления в другом окне…",
        _ => "Waiting for another window to finish installing the update…",
    }
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

/// Report an uncertain exit without claiming that the Host is still running.
pub fn quit_check_failure() -> &'static str {
    match language().as_str() {
        "pt" => "Não foi possível confirmar o encerramento com segurança. Tente novamente.",
        "zh" => "无法确认应用是否安全退出。请重试。",
        "ja" => "安全に終了できることを確認できませんでした。もう一度お試しください。",
        "es" => "No se pudo confirmar que la aplicación se pueda cerrar de forma segura. Inténtalo de nuevo.",
        "fr" => "Impossible de confirmer que l’application peut se fermer en toute sécurité. Réessayez.",
        "de" => "Es konnte nicht bestätigt werden, dass die App sicher beendet werden kann. Versuchen Sie es erneut.",
        "ru" => "Не удалось подтвердить безопасное завершение работы. Повторите попытку.",
        _ => "The application could not confirm a safe exit. Try again.",
    }
}

/// Startup failure copy.
pub fn startup_failure() -> &'static str {
    match language().as_str() {
        "pt" => "Não foi possível iniciar o Verboo Code. Feche o aplicativo e tente novamente.",
        "zh" => "无法启动 Verboo Code。请关闭应用后重试。",
        "ja" => "Verboo Code を起動できませんでした。アプリを閉じて再試行してください。",
        "es" => "No se pudo iniciar Verboo Code. Cierra la aplicación y vuelve a intentarlo.",
        "fr" => "Impossible de démarrer Verboo Code. Fermez l’application et réessayez.",
        "de" => "Verboo Code konnte nicht gestartet werden. Schließen Sie die App und versuchen Sie es erneut.",
        "ru" => "Не удалось запустить Verboo Code. Закройте приложение и попробуйте снова.",
        _ => "Verboo Code could not start. Close the app and try again.",
    }
}

/// An older process cannot prove an update has finished.
pub fn update_wait() -> &'static str {
    match language().as_str() {
        "pt" => "Uma atualização pode estar em andamento. Aguarde alguns instantes e abra o Verboo Code novamente. Se o problema persistir, reinstale usando o instalador oficial.",
        "es" => "Es posible que haya una actualización en curso. Espera unos momentos y vuelve a abrir Verboo Code. Si el problema continúa, reinstálalo con el instalador oficial.",
        "fr" => "Une mise à jour est peut-être en cours. Patientez quelques instants puis rouvrez Verboo Code. Si le problème persiste, réinstallez-le avec l’installateur officiel.",
        "de" => "Möglicherweise läuft gerade ein Update. Warten Sie einen Moment und öffnen Sie Verboo Code erneut. Wenn das Problem weiterhin besteht, installieren Sie es mit dem offiziellen Installationsprogramm erneut.",
        "zh" => "更新可能正在进行。请稍候，然后重新打开 Verboo Code。如果问题仍然存在，请使用官方安装程序重新安装。",
        "ja" => "更新が進行中の可能性があります。しばらく待ってから Verboo Code を開き直してください。問題が続く場合は、公式インストーラーで再インストールしてください。",
        "ru" => "Возможно, выполняется обновление. Подождите немного и снова откройте Verboo Code. Если проблема не исчезнет, переустановите приложение с помощью официального установщика.",
        _ => "An update may be in progress. Wait a moment and reopen Verboo Code. If the problem persists, reinstall using the official installer.",
    }
}

/// The updater retained a backup but could not restore the installed bundle.
pub fn update_rollback_failure() -> &'static str {
    match language().as_str() {
        "pt" => "Não foi possível concluir a atualização nem restaurar a instalação anterior. O backup foi preservado. Reinstale o Verboo Code usando o instalador oficial.",
        "zh" => "无法完成更新，也无法恢复以前的安装。备份已保留。请使用官方安装程序重新安装 Verboo Code。",
        "ja" => "更新を完了できず、以前のインストールも復元できませんでした。バックアップは保存されています。公式インストーラーで Verboo Code を再インストールしてください。",
        "es" => "No se pudo completar la actualización ni restaurar la instalación anterior. Se conservó la copia de seguridad. Reinstala Verboo Code con el instalador oficial.",
        "fr" => "La mise à jour et la restauration de l’installation précédente ont échoué. La sauvegarde a été conservée. Réinstallez Verboo Code avec l’installateur officiel.",
        "de" => "Das Update und die Wiederherstellung der vorherigen Installation sind fehlgeschlagen. Die Sicherung wurde behalten. Installieren Sie Verboo Code mit dem offiziellen Installationsprogramm erneut.",
        "ru" => "Не удалось завершить обновление и восстановить предыдущую установку. Резервная копия сохранена. Переустановите Verboo Code с помощью официального установщика.",
        _ => "The update could not finish and the previous installation could not be restored. The backup was preserved. Reinstall Verboo Code using the official installer.",
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
    /// Status line while validating and installing the downloaded package.
    pub finalizing_status: String,
    /// Dismiss button after a failed install.
    pub close: String,
    /// Message shown when the install fails.
    pub failed: String,
    /// Label for the safe diagnostic code shown after a failed install.
    pub diagnostic_label: String,
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
            finalizing_status: "Finalizando a instalação".into(),
            close: "Fechar".into(),
            failed: "Não foi possível concluir a atualização.".into(),
            diagnostic_label: "Código de diagnóstico".into(),
        },
        "zh" => UpdateCopy {
            title: "有可用更新".into(),
            body: format!("Verboo Code {version} 已可安装。安装完成后应用会自动重启。"),
            install: "下载并重启".into(),
            later: "稍后".into(),
            running_title: "正在更新 Verboo Code".into(),
            running_body: "这需要一点时间。安装完成后应用会自动重启。".into(),
            status: "正在下载".into(),
            finalizing_status: "正在完成安装".into(),
            close: "关闭".into(),
            failed: "无法完成更新。".into(),
            diagnostic_label: "诊断代码".into(),
        },
        "ja" => UpdateCopy {
            title: "アップデートがあります".into(),
            body: format!("Verboo Code {version} をインストールできます。完了すると自動的に再起動します。"),
            install: "ダウンロードして再起動".into(),
            later: "後で".into(),
            running_title: "Verboo Code を更新しています".into(),
            running_body: "しばらくお待ちください。インストールが終わると自動的に再起動します。".into(),
            status: "ダウンロード中".into(),
            finalizing_status: "インストールを完了しています".into(),
            close: "閉じる".into(),
            failed: "アップデートを完了できませんでした。".into(),
            diagnostic_label: "診断コード".into(),
        },
        "es" => UpdateCopy {
            title: "Actualización disponible".into(),
            body: format!("La versión {version} de Verboo Code está lista para instalarse. La aplicación se reinicia sola al terminar."),
            install: "Descargar y reiniciar".into(),
            later: "Ahora no".into(),
            running_title: "Actualizando Verboo Code".into(),
            running_body: "Esto tarda un momento. La aplicación se reinicia en cuanto termine la instalación.".into(),
            status: "Descargando".into(),
            finalizing_status: "Finalizando la instalación".into(),
            close: "Cerrar".into(),
            failed: "No se pudo completar la actualización.".into(),
            diagnostic_label: "Código de diagnóstico".into(),
        },
        "fr" => UpdateCopy {
            title: "Mise à jour disponible".into(),
            body: format!("La version {version} de Verboo Code est prête à être installée. L’application redémarre seule à la fin."),
            install: "Télécharger et redémarrer".into(),
            later: "Plus tard".into(),
            running_title: "Mise à jour de Verboo Code".into(),
            running_body: "Cela prend un instant. L’application redémarre dès que l’installation est terminée.".into(),
            status: "Téléchargement".into(),
            finalizing_status: "Finalisation de l’installation".into(),
            close: "Fermer".into(),
            failed: "La mise à jour n’a pas pu aboutir.".into(),
            diagnostic_label: "Code de diagnostic".into(),
        },
        "de" => UpdateCopy {
            title: "Update verfügbar".into(),
            body: format!("Verboo Code {version} kann installiert werden. Die App startet danach automatisch neu."),
            install: "Laden und neu starten".into(),
            later: "Später".into(),
            running_title: "Verboo Code wird aktualisiert".into(),
            running_body: "Das dauert einen Moment. Die App startet neu, sobald die Installation fertig ist.".into(),
            status: "Wird geladen".into(),
            finalizing_status: "Installation wird abgeschlossen".into(),
            close: "Schließen".into(),
            failed: "Das Update konnte nicht abgeschlossen werden.".into(),
            diagnostic_label: "Diagnosecode".into(),
        },
        "ru" => UpdateCopy {
            title: "Доступно обновление".into(),
            body: format!("Версия Verboo Code {version} готова к установке. По завершении приложение перезапустится само."),
            install: "Загрузить и перезапустить".into(),
            later: "Не сейчас".into(),
            running_title: "Обновление Verboo Code".into(),
            running_body: "Это займёт немного времени. Приложение перезапустится сразу после установки.".into(),
            status: "Загрузка".into(),
            finalizing_status: "Завершение установки".into(),
            close: "Закрыть".into(),
            failed: "Не удалось завершить обновление.".into(),
            diagnostic_label: "Код ошибки".into(),
        },
        _ => UpdateCopy {
            title: "Update available".into(),
            body: format!("Verboo Code {version} is ready to install. The app restarts on its own when it finishes."),
            install: "Download and restart".into(),
            later: "Not now".into(),
            running_title: "Updating Verboo Code".into(),
            running_body: "This takes a moment. The app restarts as soon as the installation finishes.".into(),
            status: "Downloading".into(),
            finalizing_status: "Finalizing installation".into(),
            close: "Close".into(),
            failed: "The update could not be completed.".into(),
            diagnostic_label: "Diagnostic code".into(),
        },
    }
}

/// Copy for the notice shown once an update has been applied.
/// @param version - the version now running.
/// @returns the heading, detail line and confirmation action label.
pub fn updated_copy(version: &str) -> (String, String, String) {
    updated_copy_in(&language(), version)
}

/// Copy for the applied notice in one language.
/// @param language - two-letter language of the operating system.
/// @param version - the version now running.
/// @returns the heading, detail line and confirmation action label.
pub fn updated_copy_in(language: &str, version: &str) -> (String, String, String) {
    match language {
        "pt" => (
            "Seu Verboo Code está atualizado!".into(),
            format!("Agora você está na versão {version}."),
            "OK".into(),
        ),
        "zh" => (
            "Verboo Code 已更新！".into(),
            format!("当前版本为 {version}。"),
            "确定".into(),
        ),
        "ja" => (
            "Verboo Code が最新になりました！".into(),
            format!("現在のバージョンは {version} です。"),
            "OK".into(),
        ),
        "es" => (
            "¡Tu Verboo Code está actualizado!".into(),
            format!("Ahora estás en la versión {version}."),
            "Aceptar".into(),
        ),
        "fr" => (
            "Votre Verboo Code est à jour !".into(),
            format!("Vous êtes maintenant en version {version}."),
            "OK".into(),
        ),
        "de" => (
            "Dein Verboo Code ist aktuell!".into(),
            format!("Du bist jetzt auf Version {version}."),
            "OK".into(),
        ),
        "ru" => (
            "Ваш Verboo Code обновлён!".into(),
            format!("Теперь у вас версия {version}."),
            "ОК".into(),
        ),
        _ => (
            "Your Verboo Code is up to date!".into(),
            format!("You are now on version {version}."),
            "OK".into(),
        ),
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
