import { useI18n } from '@/i18n'

const copy = {
  en: {
    runResult: 'Automation result',
    runEmpty: 'No new update from this run.',
    runError: 'Could not load this result. Try again.',
    appInventory: 'Apps on this Mac',
    appInventoryDetail:
      'App detection is ready. Dedicated read and interact permissions are not connected in this prototype yet.',
    appPending: 'Not connected',
    title: 'Settings',
    intro: 'Make Jarvis feel at home on your Mac.',
    theme: 'Jarvis appearance',
    themeDetail: 'Warm neutrals, soft lavender, and a little room to think.',
    restore: 'Use Jarvis theme',
    connections: 'Connections & permissions',
    connectionsDetail: 'Manage your AI account, files, apps, and microphone.',
    open: 'Manage connections',
    advancedDetail: 'Provider, safety, voice, and runtime controls for when you need them.',
    advancedOpen: 'Open advanced settings',
    local: 'Tasks send relevant context to your connected AI provider. Chat storage depends on your connection setup.'
  },
  ja: {
    runResult: '自動化の結果',
    runEmpty: '今回の実行に新しい報告はありません。',
    runError: '結果を読み込めませんでした。もう一度お試しください。',
    appInventory: 'このMacのアプリ',
    appInventoryDetail: 'アプリを検出しました。この試作版では、専用の読み取り・操作権限はまだ接続されていません。',
    appPending: '未接続',
    title: '設定',
    intro: 'Macで使いやすいJarvisに。',
    theme: 'Jarvisの外観',
    themeDetail: '落ち着いた色、柔らかなラベンダー、心地よい余白。',
    restore: 'Jarvisテーマを使う',
    connections: '接続とアクセス権',
    connectionsDetail: 'AIアカウント、ファイル、アプリ、マイクを管理します。',
    open: '接続を管理',
    advancedDetail: '必要に応じてプロバイダー、安全性、音声、実行環境を設定します。',
    advancedOpen: '詳細設定を開く',
    local: 'タスクに関連する情報は接続先のAIプロバイダーに送信されます。チャットの保存先は接続設定によって異なります。'
  },
  zh: {
    runResult: '自动化结果',
    runEmpty: '此次运行没有新消息。',
    runError: '无法加载结果，请重试。',
    appInventory: '这台 Mac 上的应用',
    appInventoryDetail: '已检测应用。此原型尚未接入专用的读取和操作权限。',
    appPending: '未连接',
    title: '设置',
    intro: '让 Jarvis 更适合你的 Mac。',
    theme: 'Jarvis 外观',
    themeDetail: '柔和的中性色、淡紫色与舒适的留白。',
    restore: '使用 Jarvis 主题',
    connections: '连接与权限',
    connectionsDetail: '管理 AI 账户、文件、应用和麦克风。',
    open: '管理连接',
    advancedDetail: '按需配置提供商、安全、语音和运行环境。',
    advancedOpen: '打开高级设置',
    local: '任务会将相关内容发送给已连接的 AI 提供商。聊天存储位置取决于连接设置。'
  },
  'zh-hant': {
    runResult: '自動化結果',
    runEmpty: '此次執行沒有新消息。',
    runError: '無法載入結果，請重試。',
    appInventory: '這台 Mac 上的應用程式',
    appInventoryDetail: '已偵測應用程式。此原型尚未接入專用的讀取和操作權限。',
    appPending: '未連線',
    title: '設定',
    intro: '讓 Jarvis 更適合你的 Mac。',
    theme: 'Jarvis 外觀',
    themeDetail: '柔和的中性色、淡紫色與舒適的留白。',
    restore: '使用 Jarvis 主題',
    connections: '連線與權限',
    connectionsDetail: '管理 AI 帳戶、檔案、應用程式和麥克風。',
    open: '管理連線',
    advancedDetail: '按需設定供應商、安全、語音和執行環境。',
    advancedOpen: '開啟進階設定',
    local: '任務會將相關內容傳送給已連線的 AI 供應商。聊天儲存位置取決於連線設定。'
  }
}

export function useJarvisCopy() {
  const { locale } = useI18n()

  return copy[locale as keyof typeof copy] ?? copy.en
}
