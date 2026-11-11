# OKX P2P merchant widget

`index.html` is a self-contained Telegram Bot API 10.4 widget. Send its contents as the `html` of `sendWidget` (with queries enabled). It does not fetch offers itself: the bot supplies them in `chat_data` or `public_data`, and updates them with the appropriate widget data edit method. Chat data takes precedence when both are present. An empty state is shown until offers arrive. The bot is responsible for sourcing, verifying and refreshing the offers; this widget is not affiliated with OKX.

Example state (a JSON string, subject to Telegram's 1024-byte state limit):

```json
{"updated":"Updated 14:30 UTC","offers":[{"id":"abc123","name":"Merchant name","verified":true,"orders":"1,240","completion":"99%","price":"1.00","currency":"USD","limit":"100–2,000 USD","payment":"Bank transfer"}]}
```

Buttons send `refresh` or `offer:<id>` via `TelegramWidget.request()`. IDs must contain only letters, digits, `_` or `-` and be at most 48 characters. The bot must answer each widget query and edit widget state to change the displayed offers; query answers are shown as status text only. Forwarded or preview widgets may not allow requests. No network access or external assets are used by the widget.
