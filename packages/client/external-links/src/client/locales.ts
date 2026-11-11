/** `externalLinks` namespace dictionaries: the refusal notice for a destination that never opened. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'externalLinks'

/** Key union of this namespace, taken from the dictionary that defines every key. */
export type ExternalLinksKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  unsupported: '此链接无法在当前应用中打开。',
  blocked: '浏览器阻止了此链接，请允许弹出窗口后重试。',
  nativeFailed: '无法使用系统浏览器打开此链接。',
}

/** English dictionary. */
export const en = {
  unsupported: 'This link cannot open in the app.',
  blocked: 'The browser blocked this link. Allow pop-ups and try again.',
  nativeFailed: 'The system browser could not open this link.',
} satisfies Record<keyof typeof zh, string>

/** Japanese dictionary, checked against the English keys. */
export const ja = {
  unsupported: 'このリンクはアプリ内で開けません。',
  blocked: 'ブラウザがこのリンクをブロックしました。ポップアップを許可して再試行してください。',
  nativeFailed: 'システムのブラウザでこのリンクを開けませんでした。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  unsupported: 'Este enlace no se puede abrir en la aplicación.',
  blocked: 'El navegador bloqueó este enlace. Permite las ventanas emergentes y vuelve a intentarlo.',
  nativeFailed: 'El navegador del sistema no pudo abrir este enlace.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  unsupported: 'Ce lien ne peut pas s’ouvrir dans l’application.',
  blocked: 'Le navigateur a bloqué ce lien. Autorisez les fenêtres surgissantes puis réessayez.',
  nativeFailed: 'Le navigateur du système n’a pas pu ouvrir ce lien.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  unsupported: 'Dieser Link lässt sich nicht in der App öffnen.',
  blocked: 'Der Browser hat diesen Link blockiert. Erlauben Sie Pop-ups und versuchen Sie es erneut.',
  nativeFailed: 'Der Systembrowser konnte diesen Link nicht öffnen.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  unsupported: 'Эту ссылку нельзя открыть в приложении.',
  blocked: 'Браузер заблокировал эту ссылку. Разрешите всплывающие окна и повторите попытку.',
  nativeFailed: 'Системный браузер не смог открыть эту ссылку.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  unsupported: 'Não é possível abrir este link no aplicativo.',
  blocked: 'O navegador bloqueou este link. Permita pop-ups e tente novamente.',
  nativeFailed: 'O navegador do sistema não conseguiu abrir este link.',
} satisfies Record<keyof typeof en, string>
