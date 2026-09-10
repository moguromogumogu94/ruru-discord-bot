# るる Cloudflare Workers 移行手順

## 目的
Render の常時サーバー依存を外し、Discord `/るる` を Cloudflare Workers の HTTP Interactions Endpoint で動かす。

## 1. Cloudflare Workers を GitHub から作成
1. Cloudflare Dashboard → Workers & Pages
2. Create application
3. Import a repository → Get started
4. GitHub を接続
5. `moguromogumogu94/ruru-discord-bot` を選択
6. Worker 名は `ruru-discord-worker`
7. Production branch は `main`
8. Deploy command は既定の `npx wrangler deploy`
9. Save and Deploy

## 2. Worker Secrets
Worker → Settings → Variables and Secrets に以下を Secret として登録する。

- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `MAKE_WEBHOOK_URL`

値はチャットに貼らず Cloudflare UI に直接入力する。

## 3. Discord Interactions Endpoint URL
Discord Developer Portal → 対象アプリ → General Information → Interactions Endpoint URL に Worker の `https://...workers.dev` URL を設定して保存する。

Worker は Discord の `X-Signature-Ed25519` と `X-Signature-Timestamp` を検証し、PING(type=1)には PONG(type=1) を返す。

## 4. 実動テスト
Render はまだ停止しない。

1. `/るる 札幌の明日の天気は？`
2. `/るる 今週のFRB関連ニュースを3件教えて`
3. `/るる 今週末、東京駅から箱根湯本駅までの行き方を比較して`
4. `/るる 東京オフ会の募集投稿を探して`

Discord内検索系はプライバシー保護のため ephemeral（質問者だけに表示）を優先する。

## 5. Render停止
上記4系統が Cloudflare 側で正常動作したことを確認してから Render を停止・解約する。
