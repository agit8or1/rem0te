/**
 * The emoji the chat pickers offer (0.44), on the console and on the /assist
 * page. Built in — the page's CSP loads nothing from anywhere else, and a
 * picker needs no font or image: these are ordinary Unicode characters,
 * drawn by the system's own emoji font, and inserted into the message as
 * text. A message can hold any emoji typed or pasted; this is only the menu.
 *
 * The API has the same list in apps/api/src/chat/emoji.ts
 * (scripts/check-security-invariants.mjs §45 checks the two agree).
 */
export const EMOJI: readonly string[] = [
  '😀', '😃', '😄', '😁', '😊', '🙂', '😉', '😍', '🥰', '😘', '😎', '🤓',
  '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😬', '😮', '😯', '😲', '😳',
  '🥺', '😢', '😭', '😤', '😠', '😡', '🤯', '😱', '😨', '😰', '😅', '😂',
  '🤣', '😇', '🙃', '😴', '🤒', '🤧', '🥳', '🤗', '🤭', '🤫', '🫡', '🫠',
  '👍', '👎', '👌', '✌️', '🤞', '👏', '🙌', '🙏', '💪', '👋', '🤝', '👀',
  '☝️', '👆', '👇', '👈', '👉', '✋', '🤷', '🤦', '🙋', '💁', '🙆', '🙅',
  '❤️', '💙', '💚', '💛', '🧡', '💜', '🖤', '💔', '💯', '✨', '🔥', '⭐',
  '✅', '❌', '⚠️', '❓', '❗', '⏳', '⌛', '⏰', '🕐', '📅', '📌', '📎',
  '💻', '🖥️', '⌨️', '🖱️', '🖨️', '📱', '☎️', '📞', '📧', '📨', '📁', '📂',
  '📄', '📝', '📊', '🔒', '🔓', '🔑', '🛠️', '🔧', '🔨', '⚙️', '🔌', '🔋',
  '📶', '🌐', '☁️', '💾', '💿', '🧾', '🐛', '🚀', '🎉', '☕', '🍕', '🏠',
];
