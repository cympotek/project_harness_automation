# harness-loop

**Languages:** [English](./README.md) (default) | 繁體中文 | [日本語](./README.ja.md)

自我驅動的 coding-agent 執行框架：**執行 → 驗證 → 迴圈 → 完成或上報。**

只要給它一段任務描述、一個目標 repo，以及一至多個驗證指令（lint / typecheck /
test），它就會驅動 Claude Agent SDK 對該 repo 進行修改，每次修改後重新執行你指定的
驗證指令，並將失敗的原始輸出（而非摘要）回饋給 agent 作為下一次的修復提示，最多重試
到設定的次數上限。成功就回報完成；超過上限則停止並上報給人類處理，不會無限迴圈下去。

完整產品規格請見 [`spec.md`](./spec.md)；任務歷程請見 [`Plans.md`](./Plans.md)。

> **MVP 狀態：** 單一 agent、單一任務的最小可行骨架（Phase 1，已完成）。
> 目前尚未支援任務佇列、儀表板或多 agent 協作 — 詳見 spec.md 的 Non-Goals 章節。

## 需求

- Node >= 20
- Agent SDK 可用的 Claude Code 認證：設定 `ANTHROPIC_API_KEY`，或已透過
  `claude login` 登入（訂閱制認證）。harness 本身不處理金鑰邏輯，完全依賴 SDK
  預設的認證解析機制。

## 安裝方式 — 讓其他專案使用

此套件尚未發佈到任何 registry。若要在同一台機器上對另一個 repo 使用它，請先在這裡
build 完成，再連結／安裝到目標專案。

**1. Build**

```bash
cd /path/to/project_harness_automation
npm install
npm run build   # 產生 dist/cli.js — 對應的 "harness" bin 指令
```

**2. 讓 `harness` 指令在其他地方可用 — 三選一**

```bash
# 方法 A：npm link（同時開發兩個 repo 時最方便）
npm link                       # 在 project_harness_automation 內執行
cd /path/to/other-project
npm link harness-loop

# 方法 B：全域安裝
cd /path/to/project_harness_automation
npm install -g .

# 方法 C：在目標專案的 package.json 加入 file 依賴
"harness-loop": "file:../project_harness_automation"
```

**3. 設定目標專案**

```bash
export ALLOWED_ROOTS=/absolute/path/to/other-project
# ANTHROPIC_API_KEY 可省略 — 省略時會改用 `claude login` 的訂閱制認證
```

`ALLOWED_ROOTS` 是一個強制白名單（以逗號分隔的絕對路徑）。若 `--repo` 指定的路徑不在
白名單內，會在任何 agent 或驗證指令執行前就被拒絕。若未設定，CLI 會退回成只允許
`--repo` 給定的那個路徑，並印出警告 — 快速本機測試沒問題，但正式使用時請務必明確設定。

## 使用方式 — 執行一個任務

```bash
harness run \
  --task fix-null-check-42 \
  --repo /absolute/path/to/other-project \
  --verify "npm run typecheck" \
  --verify "npm test" \
  --max-attempts 3
```

結束碼 `0` 代表通過；`1` 代表上報（escalated）或驗證輸入錯誤。

## 執行過程中發生了什麼事

1. **嘗試修改。** Agent（Claude Agent SDK，`cwd` 為你的目標 repo）直接在該 repo 的
   工作目錄中進行修改。
2. **驗證。** 每個 `--verify` 指令都會在同一個工作目錄下執行，並附帶逾時限制；逾時
   會被視為失敗，如同其他驗證結果一樣。
3. **通過 →** 迴圈停止，state 檔案寫入 `status: "passed"`，印出一行「done」訊息，
   結束碼為 `0`。
   **失敗 →** 驗證指令的原始（已遮蔽敏感資訊）輸出 — 而非摘要 — 會成為下一次嘗試的
   修復提示，嘗試次數 +1。
4. **每次嘗試後都會將狀態寫入**
   `<target-repo>/.harness/state/<task-id>.json`。若程序被中斷，之後用相同的
   `--task` id 重新執行，會從上次記錄的嘗試次數繼續，而不是從第 1 次重新開始。
5. **超過上限 →** 停止（絕不會無限重試），寫入
   `<target-repo>/.harness/escalations/<task-id>.json`（完整嘗試歷程 + 最後一次
   驗證輸出），並印出上報訊息。

harness **絕不會**碰 git — 它不會自動 commit，上報時也不會回滾目標 repo。最後一次
嘗試留在工作目錄中的變更會原封不動，讓你可以自行檢查（在目標 repo 執行
`git diff`）並手動完成，或是驗證通過後自行 commit。

## 給目標專案的注意事項

- 請將 `.harness/` 加入該專案的 `.gitignore`（state／escalation 產物會寫在這裡）。
- 目前 `--verify` 指令仍需手動指定 — 尚未支援從 `package.json` scripts 自動偵測
  （已記錄在 spec.md 的 Open Decision 中）。
- 目前這是一個本機開發迴圈工具，而非 CI 步驟 — 沒有任何設計假設它會在無人值守的
  pipeline 中執行。
