# harness-loop

**Languages:** [English](./README.md) (default) | [繁體中文](./README.zh-Hant.md) | 日本語

自走型コーディングエージェント・ハーネス：**実行 → 検証 → ループ → 完了またはエスカレーション。**

タスクの説明、対象リポジトリ、そして 1 つ以上の検証コマンド（lint / typecheck /
test）を渡すだけです。Claude Agent SDK を使って対象リポジトリを修正し、修正のたびに
指定した検証コマンドを再実行し、失敗した際はその生の出力（要約ではなく）をそのまま
次の修復プロンプトとして agent にフィードバックします。これを上限回数まで繰り返し、
成功すれば完了を報告し、上限を超えたらループを止めて人間にエスカレーションします
（無限ループにはなりません）。

完全な製品仕様は [`spec.md`](./spec.md) を、タスクの経緯は [`Plans.md`](./Plans.md) を参照してください。

> **MVP ステータス：** シングルエージェント・シングルタスクの Walking Skeleton
> （Phase 1、完了済み）。タスクキュー、ダッシュボード、マルチエージェント連携は
> まだありません — 詳細は spec.md の Non-Goals を参照。

## 必要条件

- Node >= 20
- Agent SDK が利用できる Claude Code の認証情報：`ANTHROPIC_API_KEY` を設定するか、
  すでに `claude login` でログイン済み（サブスクリプション認証）であること。harness
  自体は鍵の管理ロジックを持たず、SDK のデフォルトの認証解決に完全に依存します。

## インストール方法 — 他のプロジェクトから使う

このパッケージはまだどの registry にも公開されていません。同じマシン上の別の
リポジトリで使うには、まずここで build し、それを対象プロジェクトに
link／インストールしてください。

**1. Build**

```bash
cd /path/to/project_harness_automation
npm install
npm run build   # dist/cli.js を生成 — これが "harness" bin エントリ
```

**2. `harness` コマンドを他の場所で使えるようにする — いずれか 1 つを選択**

```bash
# 方法 A: npm link（両方の repo を同時に開発する場合に最適）
npm link                       # project_harness_automation 内で実行
cd /path/to/other-project
npm link harness-loop

# 方法 B: グローバルインストール
cd /path/to/project_harness_automation
npm install -g .

# 方法 C: 対象プロジェクトの package.json に file 依存を追加
"harness-loop": "file:../project_harness_automation"
```

**3. 対象プロジェクトを設定する**

```bash
export ALLOWED_ROOTS=/absolute/path/to/other-project
# ANTHROPIC_API_KEY は省略可 — 省略時は `claude login` のサブスクリプション認証を使用
```

`ALLOWED_ROOTS` は強制的なアローリスト（カンマ区切りの絶対パス）です。`--repo` に
指定したパスがこの中に含まれない場合、agent やセンサーの実行前に拒否されます。
未設定の場合、CLI は `--repo` で渡されたパスのみを許可する動作にフォールバックし、
警告を表示します — ローカルでの簡易的な利用には問題ありませんが、それ以上の用途
では明示的に設定してください。

## 使い方 — タスクを実行する

```bash
harness run \
  --task fix-null-check-42 \
  --repo /absolute/path/to/other-project \
  --verify "npm run typecheck" \
  --verify "npm test" \
  --max-attempts 3
```

終了コード `0` は成功、`1` はエスカレーションまたは入力検証エラーを意味します。

## 実行中に起きること

1. **修正の試行。** Agent（Claude Agent SDK、`cwd` は対象リポジトリ）が対象
   リポジトリの作業ツリーを直接編集します。
2. **検証。** 各 `--verify` コマンドが同じ作業ツリーに対してタイムアウト付きで
   実行されます。タイムアウトも他のセンサー結果と同様に失敗として扱われます。
3. **成功 →** ループが停止し、state ファイルに `status: "passed"` が書き込まれ、
   「done」の 1 行が表示され、終了コードは `0` になります。
   **失敗 →** センサーの生の（機密情報を除去した）出力 — 要約ではなく — が次の
   試行の修復プロンプトになります。試行回数がインクリメントされます。
4. **試行のたびに状態を永続化します：**
   `<target-repo>/.harness/state/<task-id>.json` に書き込まれます。プロセスが
   強制終了された後、同じ `--task` id で再実行すると、最初からではなく最後に
   記録された試行回数から再開します。
5. **上限を超えた場合 →** 停止し（無限に再試行することはありません）、
   `<target-repo>/.harness/escalations/<task-id>.json`（完全な試行履歴と最後の
   センサー出力）を書き込み、コンソールにエスカレーションメッセージを表示します。

harness は git に **一切触れません** — 自動で commit することもなく、
エスカレーション時に対象リポジトリをロールバックすることもありません。最後の試行が
作業ツリーに残した変更はそのまま残るので、対象リポジトリで `git diff` を実行して
自分で確認し、手動で仕上げるか、成功後に自分で commit してください。

## 対象プロジェクトへの注意事項

- そのプロジェクトの `.gitignore` に `.harness/` を追加してください（state／
  escalation の成果物がここに書き込まれます）。
- 現時点では `--verify` コマンドは手動指定のみです — `package.json` の scripts
  からの自動検出はまだ実装されていません（spec.md の Open Decision に記録済み）。
- 現状はローカルの開発ループ用ツールであり、CI のステップではありません —
  無人のパイプラインで実行されることは想定していません。
